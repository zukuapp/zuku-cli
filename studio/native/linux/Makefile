CC ?= cc
PKGS = gtk+-3.0 webkit2gtk-4.1 javascriptcoregtk-4.1 gio-unix-2.0
NODE_EXECUTABLE ?= /usr/bin/node
CPPFLAGS += -D_POSIX_C_SOURCE=200809L -D_XOPEN_SOURCE=700
CPPFLAGS += -DSTUDIO_NODE='"$(NODE_EXECUTABLE)"'
CFLAGS ?= -O2
CFLAGS += -std=c11 -Wall -Wextra -Wpedantic -Werror $(shell pkg-config --cflags $(PKGS))
LDLIBS += $(shell pkg-config --libs $(PKGS)) -lm

.PHONY: all check clean
all: build/zuku-studio
build/zuku-studio: studio.c protocol.c stdio-test.c protocol.h Makefile
	mkdir -p build
	$(CC) $(CPPFLAGS) $(CFLAGS) studio.c protocol.c stdio-test.c -o $@ $(LDLIBS)
check: build/zuku-studio
	./build/zuku-studio --self-test
	./build/zuku-studio --stdio-test
	$(NODE_EXECUTABLE) --check tests/stdio-fixture.mjs
clean:
	rm -f build/zuku-studio
