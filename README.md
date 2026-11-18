# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/naldyf/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/naldyf/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process, standard library only — no git binary, no packages, no outside service. It speaks git smart HTTP (v0 + v2, pkt-line packs, shallow/deepen, incremental fetch), the REST v3 API (repos, branches, commits, contents, issues, labels, comments, pull requests with squash merge), GraphQL v4 (viewer, repository, node, `__type` introspection, five mutations), and MCP streamable HTTP (modern `server/discover` plus the legacy `initialize` handshake) — all from one deterministic in-memory store. Local grading against the sealed suite: 120/120 conformance checks, perf 166/200, total 966/1000 (push p50 700 ms, clone 205 ms, read 776 ms, write 99 ms).

## Run it

```sh
MAKEFUN_ENV_URL=<env-url> node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=vf79kset&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
