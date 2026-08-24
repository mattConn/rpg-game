CXX := clang++
TARGET := rpg-tactics-native
SRC := src/main.cpp

SDL_CFLAGS := $(shell sdl2-config --cflags)
SDL_LIBS := $(shell sdl2-config --libs)
ASSIMP_PREFIX := $(shell brew --prefix assimp)

CXXFLAGS := -std=c++20 -O2 -Wall -Wextra -Wpedantic -DGL_SILENCE_DEPRECATION $(SDL_CFLAGS) -I$(ASSIMP_PREFIX)/include
LDLIBS := $(SDL_LIBS) -lSDL2_image -L$(ASSIMP_PREFIX)/lib -lassimp -framework OpenGL

.PHONY: all run smoke clean debug

all: $(TARGET)

$(TARGET): $(SRC)
	$(CXX) $(CXXFLAGS) $< -o $@ $(LDLIBS)

run: $(TARGET)
	./$(TARGET)

smoke: $(TARGET)
	./$(TARGET) --smoke-test

debug: CXXFLAGS := -std=c++20 -O0 -g -Wall -Wextra -Wpedantic -DGL_SILENCE_DEPRECATION $(SDL_CFLAGS) -I$(ASSIMP_PREFIX)/include
debug: clean $(TARGET)

clean:
	rm -f $(TARGET)
