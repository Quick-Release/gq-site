# ADR 0015: Hold only the blueprint in this repository

- Status: Accepted
- Date: 2026-10-05

## Context

gq-site had become the default home for any GETQUICK work started from it. It
held the commerce cart-lifecycle issues (#54, #57–#65), a proof of GQ
eCommerce's PHP (`proofs/cart-identity/`), research covering Ekis, GQ
eCommerce and the blueprint, and the shared vocabulary. Blueprint work and
commerce work therefore shared one backlog and release train, and couldn't
proceed in parallel.

## Decision

This repository follows
[gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md),
which assigns work across GETQUICK repositories. Under that ADR, gq-site
holds the blueprint only:

- **What stays here:** the `gq` CLI, managed files, the manifest and its
  schema, app skeletons, provisioning, CI and deploy, version pins, and fleet
  rollout. Its issues, research and ADRs are about those.
- **Shared material moves to gq-platform:** platform constraints, research
  whose owner is unknown or that binds several repositories, and the shared
  vocabulary. GLOSSARY.md keeps the blueprint and content terms and links to
  gq-platform's glossary for the shared ones.
- **Runtime behaviour moves out.** The content runtime that ADRs 0003–0013
  describe moves to `gq-content`. When it does, each of those ADRs keeps its
  provisioning parts and points to gq-content's ADR for the runtime parts.
  Commerce storefront behaviour belongs to `gq-storefront`, and the cart
  guarantee and auth contract belong to `gq-ecommerce`. The commerce variant
  only wires them up (#28).
- **Issues, proofs and research whose owner is known move to that
  owner.** A one-line stub stays at each moved document's old path.

## Consequences

- Blueprint tests of runtime code shrink to wiring checks: a generated Site
  wires the pinned runtime (keys, crontab, routes, migrations).
- Until gq-content's cut lands, no new content-runtime work starts here.
