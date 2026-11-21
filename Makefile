.PHONY: build build-web build-go clean

build: build-web build-go

build-web:
	cd web && npm install && npm run build

build-go:
	go build -o llm_tracer .

clean:
	rm -f llm_tracer
