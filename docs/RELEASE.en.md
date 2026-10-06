# Release process (server → GitHub + GHCR)

> **中文**: [RELEASE.md](RELEASE.md)

Image repository: `ghcr.io/yezi8430/chatz` (public repo; Actions builds and pushes automatically)

## Where the tags come from

Rules of `docker/metadata-action` in `.github/workflows/docker-ghcr.yml`:

| Rule | Produces | Triggered by |
|---|---|---|
| `type=ref,event=branch` | `main` | push to the main branch |
| `type=semver,pattern={{version}}` | `1.0.0` | **pushing a tag like `v1.0.0`** |
| `type=semver,pattern={{major}}.{{minor}}` | `1.0` | same as above |
| `type=sha,prefix=sha-,format=short` | `sha-527fec1` | any push |
| `type=raw,value=latest` | `latest` | main-branch build |

⚠️ **Without a tag you only ever get `latest` / `main` / `sha-xxxx`** — so `sha-527fec1` is not
garbage, it just means "there was no version number yet, so the commit hash became the tag".
Want a version number? Push a tag.

## Cutting a release (copy & paste)

```bash
cd <server-directory>

# 1. Bump the version (package.json + anywhere else it is shown)
#    - "version" in package.json
#    - any place the UI displays a version
git add -A
git commit -m "release: v1.0.1"

# 2. Tag and push (tag name must start with v and use three numbers to match v*.*.*)
git tag v1.0.1
git push origin main
git push origin v1.0.1

# 3. Wait for Actions (~2-5 min) and confirm the new tags exist
curl -s "https://ghcr.io/token?scope=repository:yezi8430/chatz:pull&service=ghcr.io" \
  | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))"
#   save that token as $TK, then:
curl -s -H "Authorization: Bearer $TK" "https://ghcr.io/v2/yezi8430/chatz/tags/list"
#   you should see 1.0.1 and 1.0
```

## Upgrading on the server

```bash
cd /root/chatz/chatz
docker compose pull
docker compose up -d
```

⚠️ If it prints `Skipped - No image to be pulled`, the local `docker-compose.yml` **is still an
old one** (or its `image:` line is actually `build: .`). Either edit the file or re-download it:

```bash
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/yezi8430/Chatz/main/docker-compose.yml
```

## Which tag to use on the server

- **`latest` (compose default)**: follows the newest main-branch build; `pull` on the server is
  all it takes, and **upgrading needs no compose edit**. Cost: it may carry unreleased changes.
- `1.0`: follows 1.0.x patches automatically; moving to 1.1 needs one manual edit.
- `1.0.0`: pinned; `docker compose pull` will not move you, but every release needs a manual edit.

`docker-compose.yml` currently uses `ghcr.io/yezi8430/chatz:latest` (not pinned).
To change it, edit that `image:` line and pull again.

## Pitfalls

| Symptom | Cause / fix |
|---|---|
| Only `sha-xxxx`, no version numbers | no tag pushed, or the tag is not in `v1.2.3` form |
| Actions returns 403 | the job is missing `permissions: packages: write` |
| `must be lowercase` | A GHCR image name must be all lowercase. The repo is `Chatz`, so `github.repository` carries a capital C — and `build-push-action`'s `outputs: type=image,name=...` does **not** lowercase it the way `metadata-action` does. A `Normalize image name` step now handles this; do not bypass it by building the name inline |
| `unknown/unknown` appears in the manifest | buildx emits a provenance attestation by default and `imagetools create` counts it as a platform. Both build steps set `provenance: false` |
| The whole run sits in Queued for 10+ minutes, then gets cancelled | **Check <https://www.githubstatus.com> first.** During a GitHub incident x86 runners can fail to be allocated (ARM runners keep working); nothing to do with the code — re-run once it recovers. Do not hit Cancel while queued: amd64 will have pushed a digest with no tag, so `latest` will not be updated |
| Build runs 10+ minutes then times out | That only happens with the old single-job `platforms: linux/amd64,linux/arm64` form (arm64 under QEMU). Now there are 3 jobs: amd64 and arm64 build **in parallel on their own native runners**, then `imagetools create` merges them — roughly 40 seconds end to end |
| Container restarted but code is old | it is image-deployed; `docker compose restart` does nothing, you need `pull` + `up -d` |
| Dockerfile changed but nothing happened | same as above; `pull` fetches the new image, nothing is built locally |
| Shell script fails with `^M` in the container | `.gitattributes` forces LF; never save new scripts with Windows line endings |

## Security

- `.env` is git-ignored: **never commit a real key to the repo or the docs.**
  Examples in `src/tokenGen.js` and `docs/*.md` must be placeholders like `cz.xxxxxxxx...`.
- Rotating the master key: change `AUTH_TOKEN` in `.env`, then `docker compose up -d`.
  On startup `src/migrate.js` syncs the "Default token" row in `devices` to the new value.
