.PHONY: dev build test shell k8s-apply

IMAGE ?= vnaviewer:latest

dev:
	docker compose up

build:
	docker build -t $(IMAGE) .

test:
	docker compose run --rm app npm test

shell:
	docker compose run --rm app sh

k8s-apply:
	IMAGE=$(IMAGE) envsubst < k8s/namespace.yaml  | kubectl apply -f -
	IMAGE=$(IMAGE) envsubst < k8s/deployment.yaml | kubectl apply -f -
	IMAGE=$(IMAGE) envsubst < k8s/service.yaml    | kubectl apply -f -
	IMAGE=$(IMAGE) envsubst < k8s/ingress.yaml    | kubectl apply -f -
