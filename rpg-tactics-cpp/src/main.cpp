#include <SDL.h>
#include <SDL_image.h>
#include <OpenGL/gl.h>
#include <OpenGL/glu.h>
#include <assimp/Importer.hpp>
#include <assimp/material.h>
#include <assimp/postprocess.h>
#include <assimp/scene.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <random>
#include <string>
#include <vector>

namespace {

constexpr float PI = 3.14159265358979323846f;
constexpr float PLAYER_RADIUS = 0.48f;
constexpr float PLAYER_SPEED = 200.0f / 30.0f;
constexpr float PLAYER_RUN_SPEED = PLAYER_SPEED * 1.6f;
constexpr float MELEE_RANGE = 4.5f;
constexpr float AGGRO_RANGE = MELEE_RANGE * 1.2f;
constexpr float ATTACK_HALF_ANGLE = 35.0f * PI / 180.0f;
constexpr float DIRECT_HALF_ANGLE = 15.0f * PI / 180.0f;

struct Vec2 {
  float x = 0, z = 0;
  Vec2 operator+(Vec2 b) const { return {x + b.x, z + b.z}; }
  Vec2 operator-(Vec2 b) const { return {x - b.x, z - b.z}; }
  Vec2 operator*(float s) const { return {x * s, z * s}; }
  Vec2& operator+=(Vec2 b) { x += b.x; z += b.z; return *this; }
};

float length(Vec2 v) { return std::sqrt(v.x * v.x + v.z * v.z); }
Vec2 normalized(Vec2 v) { const float n = length(v); return n > 0.0001f ? v * (1.0f / n) : Vec2{1, 0}; }
float dot(Vec2 a, Vec2 b) { return a.x * b.x + a.z * b.z; }
float clampf(float v, float lo, float hi) { return std::max(lo, std::min(hi, v)); }
float lerpf(float a, float b, float t) { return a + (b - a) * t; }

struct Rect { float minX, maxX, minZ, maxZ; };
constexpr std::array<Rect, 5> WALKABLE{{
  {-9.9f, 9.9f, -9.9f, 9.9f}, {-3, 3, 9.9f, 33.9f}, {-9.9f, 9.9f, 33.9f, 53.7f},
  {-3, 3, 53.7f, 66.9f}, {-9.9f, 9.9f, 66.9f, 86.7f},
}};

bool inWalkable(Vec2 p, float margin = 0) {
  for (const auto& r : WALKABLE)
    if (p.x >= r.minX + margin && p.x <= r.maxX - margin &&
        p.z >= r.minZ + margin && p.z <= r.maxZ - margin) return true;
  return false;
}

Vec2 resolveMove(Vec2 from, Vec2 delta, float radius) {
  Vec2 out = from;
  Vec2 xTry{from.x + delta.x, from.z};
  if (inWalkable(xTry, radius)) out.x = xTry.x;
  Vec2 zTry{out.x, from.z + delta.z};
  if (inWalkable(zTry, radius)) out.z = zTry.z;
  return out;
}

enum class EnemyKind { Hound, Bat };

struct Enemy {
  EnemyKind kind = EnemyKind::Hound;
  Vec2 pos{};
  Vec2 heading{0, -1};
  float altitude = 0;
  float health = 150;
  float maxHealth = 150;
  bool aggro = false;
  bool dead = false;
  bool consumed = false;
  float attackCooldown = 0;
  float diveCooldown = 0;
  float orbit = 0;
  float deathAge = 0;
  float wingPhase = 0;
  float attackLock = 0;
  float diveAge = -1;
  Vec2 diveOrigin{};
  Vec2 diveTarget{};
};

struct Particle {
  float x, y, z, vx, vy, vz, age, life;
  float r, g, b, size;
};

struct Game {
  Vec2 player{-0.3f, 0.3f};
  Vec2 facing{0, 1};
  float playerHealth = 100;
  float attackCooldown = 0;
  float eatLock = 0;
  float eatBurst = 0;
  Enemy hound{EnemyKind::Hound, {7.5f, 7.5f}, {-1, 0}, 0, 150, 150};
  Enemy bat{EnemyKind::Bat, {0, 76.8f}, {1, 0}, 4.2f, 80, 80};
  std::vector<Particle> particles;
  bool showHitboxes = false;
  std::mt19937 rng{std::random_device{}()};

  void blood(float x, float y, float z, int count = 18) {
    std::uniform_real_distribution<float> unit(0, 1), spread(-1, 1);
    for (int i = 0; i < count; ++i) {
      particles.push_back({x, y, z, spread(rng) * 2.4f, unit(rng) * 3.5f + 0.8f,
        spread(rng) * 2.4f, 0, 0.65f, 0.24f, 0.005f, 0.012f, unit(rng) * 5 + 4});
    }
  }

  bool hittable(const Enemy& e) const {
    if (e.dead) return false;
    Vec2 d = e.pos - player;
    const float gap = length(d);
    if (gap > MELEE_RANGE + (e.kind == EnemyKind::Hound ? 0.6f : 0)) return false;
    if (dot(normalized(d), facing) < std::cos(ATTACK_HALF_ANGLE)) return false;
    return e.kind != EnemyKind::Bat || e.altitude < 3.2f;
  }

  void attack() {
    if (attackCooldown > 0 || eatLock > 0) return;
    attackCooldown = 0.6f;
    Enemy* target = nullptr;
    if (hittable(hound)) target = &hound;
    if (hittable(bat) && (!target || length(bat.pos - player) < length(target->pos - player))) target = &bat;
    if (!target) return;
    const float alignment = dot(normalized(target->pos - player), facing);
    target->health -= alignment >= std::cos(DIRECT_HALF_ANGLE) ? 25 : 20;
    target->aggro = true;
    blood(target->pos.x, target->kind == EnemyKind::Bat ? target->altitude : 1.2f, target->pos.z);
    if (target->health <= 0) { target->health = 0; target->dead = true; target->deathAge = 0; }
  }

  void eat() {
    if (eatLock > 0) return;
    Enemy* corpse = nullptr;
    if (hound.dead && !hound.consumed && length(hound.pos - player) < 1.7f) corpse = &hound;
    if (bat.dead && !bat.consumed && length(bat.pos - player) < 1.7f) corpse = &bat;
    if (!corpse) return;
    corpse->consumed = true;
    eatLock = 1.0f;
    eatBurst = 0.18f;
    playerHealth = std::min(100.0f, playerHealth + (corpse->kind == EnemyKind::Bat ? 15.0f : 30.0f));
    blood(corpse->pos.x, 0.55f, corpse->pos.z, 24);
  }

  void updateEnemy(Enemy& e, float dt) {
    if (e.dead) { e.deathAge += dt; return; }
    e.attackCooldown = std::max(0.0f, e.attackCooldown - dt);
    e.attackLock = std::max(0.0f, e.attackLock - dt);
    const Vec2 toPlayer = player - e.pos;
    const float gap = length(toPlayer);
    if (gap <= AGGRO_RANGE * (e.kind == EnemyKind::Bat ? 1.25f : 1.0f)) e.aggro = true;
    if (e.kind == EnemyKind::Bat) {
      e.wingPhase += dt * 8;
      e.diveCooldown = std::max(0.0f, e.diveCooldown - dt);
      if (!e.aggro) { e.orbit += dt * .72f; e.pos = {std::cos(e.orbit) * 4.05f, 76.8f + std::sin(e.orbit) * 4.05f}; e.heading={-std::sin(e.orbit),std::cos(e.orbit)}; e.altitude = 4.2f; return; }
      if(e.diveAge >= 0) {
        e.diveAge += dt;
        if(e.diveAge < .65f) {
          float t=clampf(e.diveAge/.65f,0,1);t=t*t*(3-2*t);
          e.pos=e.diveOrigin+(e.diveTarget-e.diveOrigin)*t;
          e.heading=normalized(e.diveTarget-e.pos);
          e.altitude=lerpf(2.25f,.9f,t);
        } else if(e.diveAge < 1.15f) {
          e.altitude=.9f;
          if(e.diveAge-dt < .65f && gap <= 3.24f && dot(e.heading,normalized(toPlayer)) >= std::cos(PI/4)) {
            playerHealth=std::max(0.0f,playerHealth-10);blood(player.x,.9f,player.z);
            if(std::uniform_real_distribution<float>(0,1)(rng)<.2f)e.health=std::min(e.maxHealth,e.health+10);
          }
        } else if(e.diveAge < 1.65f) e.altitude=lerpf(.9f,2.25f,(e.diveAge-1.15f)/.5f);
        else { e.diveAge=-1;e.diveCooldown=1.8f; }
        return;
      }
      e.orbit += dt * 0.9f;
      Vec2 desired = player + Vec2{std::cos(e.orbit) * 5.85f, std::sin(e.orbit) * 5.85f};
      e.heading = normalized(desired - e.pos);
      if(gap>5.265f)e.pos=resolveMove(e.pos,e.heading*((92.0f/30.0f)*dt),.4f);
      e.altitude=2.25f;
      if(e.diveCooldown<=0&&gap<=7.65f){e.diveAge=0;e.diveOrigin=e.pos;e.diveTarget=player;}
      return;
    }
    if (!e.aggro) { e.orbit+=dt*(50.0f/30.0f);e.pos.x=7.5f+std::sin(e.orbit)*2.25f;e.heading={std::cos(e.orbit)>=0?1.0f:-1.0f,0};return; }
    if(e.attackLock>0)return;
    const Vec2 wanted=normalized(toPlayer);float current=std::atan2(e.heading.z,e.heading.x),target=std::atan2(wanted.z,wanted.x),delta=std::remainder(target-current,2*PI);current+=clampf(delta,-2.2f*dt,2.2f*dt);e.heading={std::cos(current),std::sin(current)};
    if (gap > MELEE_RANGE) e.pos = resolveMove(e.pos, e.heading * ((140.0f/30.0f) * dt), 0.65f);
    if (gap <= MELEE_RANGE && dot(e.heading, normalized(toPlayer)) >= std::cos(35 * PI / 180) && e.attackCooldown <= 0) {
      const float damage = std::uniform_int_distribution<int>(0, 1)(rng) ? 20.0f : 10.0f;
      playerHealth = std::max(0.0f, playerHealth - damage);
      blood(player.x, 0.9f, player.z);
      e.attackCooldown = 1.5f;e.attackLock=1.25f;
    }
  }

  void update(float dt, Vec2 move, bool run) {
    attackCooldown = std::max(0.0f, attackCooldown - dt);
    eatLock = std::max(0.0f, eatLock - dt);
    if (eatBurst > 0) {
      eatBurst -= dt;
      if (eatBurst <= 0) {
        Enemy& c = hound.consumed && length(hound.pos-player)<2 ? hound : bat;
        blood(c.pos.x, 0.55f, c.pos.z, 24);
      }
    }
    if (eatLock <= 0 && length(move) > 0.01f && playerHealth > 0) {
      move = normalized(move);
      facing = move;
      player = resolveMove(player, move * ((run ? PLAYER_RUN_SPEED : PLAYER_SPEED) * dt), PLAYER_RADIUS);
    }
    updateEnemy(hound, dt); updateEnemy(bat, dt);
    for (auto& p : particles) { p.age += dt; p.x += p.vx*dt; p.y += p.vy*dt; p.z += p.vz*dt; p.vy -= 7*dt; }
    std::erase_if(particles, [](const Particle& p){ return p.age >= p.life; });
  }
};

GLuint loadTexture(const std::string& path) {
  SDL_Surface* loaded = IMG_Load(path.c_str());
  if (!loaded) { std::cerr << "texture: " << path << ": " << IMG_GetError() << '\n'; return 0; }
  SDL_Surface* rgba = SDL_ConvertSurfaceFormat(loaded, SDL_PIXELFORMAT_RGBA32, 0); SDL_FreeSurface(loaded);
  GLuint id = 0; glGenTextures(1, &id); glBindTexture(GL_TEXTURE_2D, id);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT); glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, rgba->w, rgba->h, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba->pixels);
  glGenerateMipmap(GL_TEXTURE_2D); SDL_FreeSurface(rgba); return id;
}

struct ImportedMesh {
  std::vector<float> positions,normals,uvs;
  std::vector<unsigned> indices;
  GLuint texture=0;
};

struct ImportedModel {
  std::vector<ImportedMesh> meshes;
  float centreX=0,centreY=0,centreZ=0,extent=1;

  bool load(const std::string& path,bool centreVertically=false) {
    Assimp::Importer importer;
    const aiScene* scene=importer.ReadFile(path,aiProcess_Triangulate|aiProcess_GenSmoothNormals|aiProcess_JoinIdenticalVertices|aiProcess_PreTransformVertices|aiProcess_FlipUVs);
    if(!scene){std::cerr<<"model: "<<path<<": "<<importer.GetErrorString()<<'\n';return false;}
    const std::filesystem::path base=std::filesystem::path(path).parent_path();
    float minX=1e30f,minY=1e30f,minZ=1e30f,maxX=-1e30f,maxY=-1e30f,maxZ=-1e30f;
    for(unsigned mi=0;mi<scene->mNumMeshes;++mi){const aiMesh* source=scene->mMeshes[mi];ImportedMesh mesh;
      mesh.positions.reserve(source->mNumVertices*3);mesh.normals.reserve(source->mNumVertices*3);mesh.uvs.reserve(source->mNumVertices*2);
      for(unsigned i=0;i<source->mNumVertices;++i){const auto&p=source->mVertices[i];const auto&n=source->mNormals[i];
        mesh.positions.insert(mesh.positions.end(),{p.x,p.y,p.z});mesh.normals.insert(mesh.normals.end(),{n.x,n.y,n.z});
        if(source->HasTextureCoords(0))mesh.uvs.insert(mesh.uvs.end(),{source->mTextureCoords[0][i].x,source->mTextureCoords[0][i].y});else mesh.uvs.insert(mesh.uvs.end(),{0,0});
        // The browser rotates the imported wolf 90 degrees around Y before fitting it.
        const float rx=p.z,rz=-p.x;minX=std::min(minX,rx);maxX=std::max(maxX,rx);minY=std::min(minY,p.y);maxY=std::max(maxY,p.y);minZ=std::min(minZ,rz);maxZ=std::max(maxZ,rz);
      }
      for(unsigned f=0;f<source->mNumFaces;++f)for(unsigned i=0;i<source->mFaces[f].mNumIndices;++i)mesh.indices.push_back(source->mFaces[f].mIndices[i]);
      if(source->mMaterialIndex<scene->mNumMaterials){aiString uri;const aiMaterial* material=scene->mMaterials[source->mMaterialIndex];
        if(material->GetTexture(aiTextureType_BASE_COLOR,0,&uri)!=AI_SUCCESS)material->GetTexture(aiTextureType_DIFFUSE,0,&uri);
        if(uri.length)mesh.texture=loadTexture((base/std::filesystem::path(uri.C_Str())).lexically_normal().string());
      }meshes.push_back(std::move(mesh));
    }
    centreX=(minX+maxX)/2;centreY=centreVertically?(minY+maxY)/2:minY;centreZ=(minZ+maxZ)/2;extent=std::max({maxX-minX,maxY-minY,maxZ-minZ,.0001f});return true;
  }

  void draw(float fittedSize,float r,float g,float b) const {
    glPushMatrix();glScalef(fittedSize/extent,fittedSize/extent,fittedSize/extent);glTranslatef(-centreX,-centreY,-centreZ);glRotatef(90,0,1,0);glColor3f(r,g,b);
    for(const auto&mesh:meshes){if(mesh.texture){glEnable(GL_TEXTURE_2D);glBindTexture(GL_TEXTURE_2D,mesh.texture);}else glDisable(GL_TEXTURE_2D);
      glEnableClientState(GL_VERTEX_ARRAY);glEnableClientState(GL_NORMAL_ARRAY);glEnableClientState(GL_TEXTURE_COORD_ARRAY);
      glVertexPointer(3,GL_FLOAT,0,mesh.positions.data());glNormalPointer(GL_FLOAT,0,mesh.normals.data());glTexCoordPointer(2,GL_FLOAT,0,mesh.uvs.data());
      glDrawElements(GL_TRIANGLES,(GLsizei)mesh.indices.size(),GL_UNSIGNED_INT,mesh.indices.data());
      glDisableClientState(GL_TEXTURE_COORD_ARRAY);glDisableClientState(GL_NORMAL_ARRAY);glDisableClientState(GL_VERTEX_ARRAY);
    }glDisable(GL_TEXTURE_2D);glPopMatrix();
  }
};

void cube(float sx, float sy, float sz) {
  const float x=sx/2,y=sy/2,z=sz/2;
  glBegin(GL_QUADS);
  const std::array<std::array<float,12>,6> v{{
    {{-x,-y,z,x,-y,z,x,y,z,-x,y,z}}, {{x,-y,-z,-x,-y,-z,-x,y,-z,x,y,-z}},
    {{-x,-y,-z,-x,-y,z,-x,y,z,-x,y,-z}}, {{x,-y,z,x,-y,-z,x,y,-z,x,y,z}},
    {{-x,y,z,x,y,z,x,y,-z,-x,y,-z}}, {{-x,-y,-z,x,-y,-z,x,-y,z,-x,-y,z}}
  }};
  const float normals[6][3]={{0,0,1},{0,0,-1},{-1,0,0},{1,0,0},{0,1,0},{0,-1,0}};
  for(int f=0;f<6;++f){glNormal3fv(normals[f]); for(int i=0;i<4;++i){glTexCoord2f((i==1||i==2)?1:0,(i>=2)?1:0);glVertex3f(v[f][i*3],v[f][i*3+1],v[f][i*3+2]);}}
  glEnd();
}

struct Renderer {
  GLuint floorTex=0, wallTex=0;
  ImportedModel wolfAsset,batAsset;
  float camYaw=PI, camPitch=.16f;
  int width=1280,height=720;

  void init() {
    glEnable(GL_DEPTH_TEST); glEnable(GL_CULL_FACE); glEnable(GL_COLOR_MATERIAL); glEnable(GL_NORMALIZE);
    glEnable(GL_LIGHTING); glEnable(GL_LIGHT0); glEnable(GL_FOG); glEnable(GL_BLEND); glBlendFunc(GL_SRC_ALPHA,GL_ONE_MINUS_SRC_ALPHA);
    GLfloat ambient[]={.25f,.27f,.34f,1}, diffuse[]={.62f,.58f,.52f,1}, pos[]={-10,18,-4,1};
    glLightfv(GL_LIGHT0,GL_AMBIENT,ambient);glLightfv(GL_LIGHT0,GL_DIFFUSE,diffuse);glLightfv(GL_LIGHT0,GL_POSITION,pos);
    GLfloat fog[]={.035f,.04f,.065f,1};glFogfv(GL_FOG_COLOR,fog);glFogi(GL_FOG_MODE,GL_LINEAR);glFogf(GL_FOG_START,24);glFogf(GL_FOG_END,62);
    floorTex=loadTexture("../rpg-tactics/public/textures/dungeon-floor-stone.png");
    wallTex=loadTexture("../rpg-tactics/public/textures/dungeon-wall-stone.png");
    wolfAsset.load("../public/models/gray-wolf/scene.gltf");
    batAsset.load("../public/models/bat/scene.gltf",true);
  }

  void texturedBox(float x,float y,float z,float sx,float sy,float sz,GLuint tex) {
    glEnable(GL_TEXTURE_2D);glBindTexture(GL_TEXTURE_2D,tex);glColor3f(.72f,.72f,.76f);glPushMatrix();glTranslatef(x,y,z);cube(sx,sy,sz);glPopMatrix();glDisable(GL_TEXTURE_2D);
  }

  void room(const Rect& r, float northOpening=0, float southOpening=0) {
    texturedBox((r.minX+r.maxX)/2,-.12f,(r.minZ+r.maxZ)/2,r.maxX-r.minX,.22f,r.maxZ-r.minZ,floorTex);
    constexpr float H=8.4f,T=.42f;
    texturedBox(r.minX-T/2,H/2,r.minZ+(r.maxZ-r.minZ)/2,T,H,r.maxZ-r.minZ+T,wallTex);
    texturedBox(r.maxX+T/2,H/2,r.minZ+(r.maxZ-r.minZ)/2,T,H,r.maxZ-r.minZ+T,wallTex);
    auto endWall=[&](float z,float opening){
      const float width=r.maxX-r.minX;
      if(opening<=0)texturedBox((r.minX+r.maxX)/2,H/2,z,width+T,H,T,wallTex);
      else {float side=(width-opening)/2;texturedBox(r.minX+side/2,H/2,z,side,H,T,wallTex);texturedBox(r.maxX-side/2,H/2,z,side,H,T,wallTex);}
    };
    endWall(r.minZ-T/2,northOpening);endWall(r.maxZ+T/2,southOpening);
  }

  void walls() {
    room(WALKABLE[0],0,4.8f);room(WALKABLE[1],6,6);room(WALKABLE[2],6,4.8f);
    room(WALKABLE[3],6,6);room(WALKABLE[4],6,0);
  }

  void healthBar(float x,float y,float z,float value,float max,float width) {
    glDisable(GL_LIGHTING);glDisable(GL_DEPTH_TEST);glPushMatrix();glTranslatef(x,y,z);glRotatef(-camYaw*180/PI,0,1,0);
    glColor3f(.03f,.03f,.03f);glBegin(GL_QUADS);glVertex3f(-width/2,-.1f,0);glVertex3f(width/2,-.1f,0);glVertex3f(width/2,.1f,0);glVertex3f(-width/2,.1f,0);glEnd();
    float w=width*clampf(value/max,0,1);glColor3f(.75f,.05f,.04f);glBegin(GL_QUADS);glVertex3f(-width/2,-.075f,.01f);glVertex3f(-width/2+w,-.075f,.01f);glVertex3f(-width/2+w,.075f,.01f);glVertex3f(-width/2,.075f,.01f);glEnd();glPopMatrix();glEnable(GL_DEPTH_TEST);glEnable(GL_LIGHTING);
  }

  void ring(Vec2 p,float y,float radius,float r,float g,float b,float alpha=1) {
    glDisable(GL_LIGHTING);glColor4f(r,g,b,alpha);glLineWidth(2);glBegin(GL_LINE_LOOP);for(int i=0;i<40;++i){float a=i*2*PI/40;glVertex3f(p.x+std::cos(a)*radius,y,p.z+std::sin(a)*radius);}glEnd();glEnable(GL_LIGHTING);
  }

  void render(Game& game) {
    glViewport(0,0,width,height);glClearColor(.035f,.04f,.065f,1);glClear(GL_COLOR_BUFFER_BIT|GL_DEPTH_BUFFER_BIT);
    glMatrixMode(GL_PROJECTION);glLoadIdentity();gluPerspective(50.0,(double)width/height,.1,180);
    glMatrixMode(GL_MODELVIEW);glLoadIdentity();
    const float dist=3.96f, horiz=std::cos(camPitch)*dist;
    const float cx=game.player.x+std::sin(camYaw)*horiz, cy=std::sin(camPitch)*dist+2, cz=game.player.z+std::cos(camYaw)*horiz;
    gluLookAt(cx,cy,cz,game.player.x,1,game.player.z,0,1,0);
    walls();
    glPushMatrix();glTranslatef(game.player.x,0,game.player.z);glRotatef(std::atan2(-game.facing.z,game.facing.x)*180/PI,0,1,0);wolfAsset.draw(1.35f,1,1,1);glPopMatrix();
    for(Enemy* e:{&game.hound,&game.bat}){
      float y=e->kind==EnemyKind::Bat?(e->dead?std::max(.3f,e->altitude-e->deathAge*7):e->altitude):0;
      glPushMatrix();glTranslatef(e->pos.x,y,e->pos.z);glRotatef(std::atan2(-e->heading.z,e->heading.x)*180/PI,0,1,0);glScalef(e->kind==EnemyKind::Hound?1.95f:1,e->kind==EnemyKind::Hound?1.95f:1,e->kind==EnemyKind::Hound?1.95f:1);
      if(e->dead){if(e->kind==EnemyKind::Bat)glRotatef(std::min(180.0f,e->deathAge*260),1,0,0);else glRotatef(std::min(90.0f,e->deathAge*140),1,0,0);}
      if(e->kind==EnemyKind::Hound)wolfAsset.draw(1.35f,.13f,.10f,.12f);else batAsset.draw(9.6f,.42f,.22f,.24f);glPopMatrix();
      if(!e->dead&&e->aggro&&length(e->pos-game.player)<12)healthBar(e->pos.x,y+2.4f,e->pos.z,e->health,e->maxHealth,e->kind==EnemyKind::Bat?2.8f:2.3f);
      if(game.showHitboxes&&!e->dead)ring(e->pos,.05f,e->kind==EnemyKind::Bat?4.5f:1.25f,1,0,0,.8f);
    }
    if(game.hittable(game.hound))ring(game.hound.pos,1.3f,.24f,1,1,1,.5f);
    else if(game.hittable(game.bat))ring(game.bat.pos,game.bat.altitude,.24f,1,1,1,.5f);
    glDisable(GL_LIGHTING);glEnable(GL_POINT_SMOOTH);for(const auto&p:game.particles){glPointSize(p.size);glColor4f(p.r,p.g,p.b,1-p.age/p.life);glBegin(GL_POINTS);glVertex3f(p.x,p.y,p.z);glEnd();}glEnable(GL_LIGHTING);
    // HUD in normalized screen coordinates.
    glDisable(GL_LIGHTING);glDisable(GL_DEPTH_TEST);glMatrixMode(GL_PROJECTION);glPushMatrix();glLoadIdentity();glOrtho(0,width,height,0,-1,1);glMatrixMode(GL_MODELVIEW);glPushMatrix();glLoadIdentity();
    auto bar=[&](float y,float ratio,float r,float g,float b){glColor3f(.02f,.02f,.025f);glBegin(GL_QUADS);glVertex2f(18,y);glVertex2f(278,y);glVertex2f(278,y+24);glVertex2f(18,y+24);glEnd();glColor3f(r,g,b);glBegin(GL_QUADS);glVertex2f(22,y+4);glVertex2f(22+252*ratio,y+4);glVertex2f(22+252*ratio,y+20);glVertex2f(22,y+20);glEnd();};
    bar(18,game.playerHealth/100,.78f,.08f,.06f);
    glPopMatrix();glMatrixMode(GL_PROJECTION);glPopMatrix();glMatrixMode(GL_MODELVIEW);glEnable(GL_DEPTH_TEST);glEnable(GL_LIGHTING);
  }
};

} // namespace

int main(int argc, char** argv) {
  const bool smokeTest = argc > 1 && std::string(argv[1]) == "--smoke-test";
  if (SDL_Init(SDL_INIT_VIDEO|SDL_INIT_TIMER) != 0) { std::cerr<<SDL_GetError()<<'\n'; return 1; }
  IMG_Init(IMG_INIT_PNG);
  SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION,2);SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION,1);
  SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER,1);SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE,24);
  SDL_Window* window=SDL_CreateWindow("RPG Tactics — Native",SDL_WINDOWPOS_CENTERED,SDL_WINDOWPOS_CENTERED,1280,720,SDL_WINDOW_OPENGL|SDL_WINDOW_RESIZABLE|SDL_WINDOW_ALLOW_HIGHDPI);
  if(!window){std::cerr<<SDL_GetError()<<'\n';return 1;} SDL_GLContext context=SDL_GL_CreateContext(window);SDL_GL_SetSwapInterval(1);
  Renderer renderer;renderer.init();Game game;bool running=true,cameraDrag=false,dragMoved=false;Uint8 dragButton=0;int renderedFrames=0;uint64_t last=SDL_GetPerformanceCounter();
  while(running){SDL_Event e;while(SDL_PollEvent(&e)){if(e.type==SDL_QUIT)running=false;else if(e.type==SDL_KEYDOWN&&!e.key.repeat){if(e.key.keysym.sym==SDLK_ESCAPE)running=false;else if(e.key.keysym.sym==SDLK_e)game.eat();else if(e.key.keysym.sym==SDLK_h)game.showHitboxes=!game.showHitboxes;}else if(e.type==SDL_MOUSEBUTTONDOWN&&(e.button.button==SDL_BUTTON_LEFT||e.button.button==SDL_BUTTON_RIGHT)){cameraDrag=true;dragMoved=false;dragButton=e.button.button;}else if(e.type==SDL_MOUSEBUTTONUP&&e.button.button==dragButton){if(dragButton==SDL_BUTTON_LEFT&&!dragMoved)game.attack();cameraDrag=false;dragButton=0;}else if(e.type==SDL_MOUSEMOTION&&cameraDrag){if(std::abs(e.motion.xrel)+std::abs(e.motion.yrel)>0)dragMoved=true;renderer.camYaw-=e.motion.xrel*.006f;renderer.camPitch=clampf(renderer.camPitch-e.motion.yrel*.004f,.08f,1.45f);}else if(e.type==SDL_WINDOWEVENT&&e.window.event==SDL_WINDOWEVENT_SIZE_CHANGED){renderer.width=e.window.data1;renderer.height=e.window.data2;}}
    uint64_t now=SDL_GetPerformanceCounter();float dt=std::min(.05f,(float)(now-last)/SDL_GetPerformanceFrequency());last=now;
    const Uint8* keys=SDL_GetKeyboardState(nullptr);Vec2 forward{-std::sin(renderer.camYaw),-std::cos(renderer.camYaw)},right{std::cos(renderer.camYaw),-std::sin(renderer.camYaw)};Vec2 move{};if(keys[SDL_SCANCODE_W])move+=forward;if(keys[SDL_SCANCODE_S])move+=forward*-1;if(keys[SDL_SCANCODE_D])move+=right;if(keys[SDL_SCANCODE_A])move+=right*-1;game.update(dt,move,keys[SDL_SCANCODE_LSHIFT]||keys[SDL_SCANCODE_RSHIFT]);renderer.render(game);SDL_GL_SwapWindow(window);
    if(smokeTest && ++renderedFrames >= 3) running=false;
  }
  SDL_GL_DeleteContext(context);SDL_DestroyWindow(window);IMG_Quit();SDL_Quit();return 0;
}
