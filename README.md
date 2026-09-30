# Shipwright site

The public Shipwright page: a measured optimization leaderboard for
[oh-my-pi](https://github.com/EasySchedule/oh-my-pi). It reads
`public.optimizations` from Supabase over the anon key, under row level
security, and is hosted on Netlify.

No framework, no bundler, no runtime dependencies. The page is hand-written
HTML, CSS and browser-native ES modules. The only build step is one Node
standard library script. Every dependency is something that can break at deploy
time, and a leaderboard does not need one.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Build, then serve `dist/` on <http://localhost:4321>. |
| `npm run build` | Build `dist/` for deploy. This is the Netlify build command. |
| `npm run measure` | Report the byte budgets and the XSS scan. Exits non-zero on a breach. |
| `npm run measure:selftest` | Prove `measure` can still fail. Exits non-zero if it cannot. |

Both are Node 20+. There is nothing to install: `npm install` is a no-op
because there is no `dependencies` block.

For local builds, copy the example environment file and fill in your own
values:

```sh
cp .env.example .env
```

## Measuring

The spec budgets the static shell, first-party JavaScript, first-load weight
and the Supabase response body, and it forbids four HTML sinks in `src/`. Those
are numbers, so they come from one command rather than from whatever each
person typed.

```sh
npm run measure -- --runs 10
```

Exit 0 when every budget passes and the scan is clean, 1 on a budget breach or
a match, 2 when it cannot produce a number. The three exit codes are distinct
on purpose: "2" means the harness refused, and a refusal is not a pass.

`SUPABASE_URL` and `SUPABASE_ANON_KEY` must be set, because the build under
test requires them. To measure only the credential-independent budgets without
holding a key, pass `--placeholder-config`. It builds against a synthetic
credential of a stated length and marks every figure derived from it.

Five things the harness does that a hand-run command does not. Each of them is
a way a plausible number goes wrong.

**1. `gzip -c` writes the filename into the gzip header.** The count moves by
one byte per character of the name, so renaming a file moves the measurement
without a byte of the code changing. Every count here is content only.

**2. zlib and GNU gzip are different encoders, and they disagree.** Measured on
this tree, for identical bytes: zlib is 20 bytes larger for `dist/main.js`, 22
*smaller* for `dist/styles.css`. So a hand-run `gzip` and this harness can land
on opposite sides of a budget. The harness measures both and prints the delta.
If a verdict would flip between them it reports `UNSETTLED` instead of
publishing the flattering number.

**3. A single number hides an unstable build.** Every measurement is taken
across N rebuilds and reported with min/max/mean/median/spread. A build whose
output size moves between runs on the same input has a defect, and this is
where that surfaces.

**4. "First load" is not "everything in `dist/`".** The visitor-reachable set is
derived from `dist/index.html` by reading `<link href>` and `<script src>`. An
Open Graph image referenced only from a `<meta>` tag is fetched by crawlers, so
it is reported as shipped weight instead of charged to the first-load budget.
On this tree that is the difference between 8.3 KB and 26.6 KB.

**5. "0 matches" can mean the scan never ran.** The harness prints the files it
read. Reading zero files is `NOT SCANNED` and fails. It also refuses to guess
when it cannot derive the file set: no entry document, two entry documents, or
a reference the build did not produce are all exit 2.

`npm run measure:selftest` drives the harness through the cases that must fail
and asserts on its exit code *and* its output, because a harness that exits 1
for an unrelated reason has not proved anything. It needs no credential and no
network.

## Environment variables

The build reads exactly two variables. They are required; there are no
optional ones.

| Name | What it is |
| --- | --- |
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://<project-ref>.supabase.co`. |
| `SUPABASE_ANON_KEY` | The Supabase anon (publishable) key. Public by design, bounded by row level security. |

**Names only. No values belong in this file, in a commit, in an issue, or in a
PR description.**

`scripts/build.mjs` exits non-zero and prints the name of any missing variable,
so a missing credential is a red build on the machine doing the building rather
than a deployed page that silently cannot read the database. It also treats an
empty or whitespace-only value as missing.

The Supabase **service-role** key is not supported and must never appear in this
repository, in a build variable, or in any client bundle. It bypasses row level
security. Leaderboard writes are service-role only and run from a trusted
backend.

## Layout

```
src/            source. Copied to dist/; .js files are minified.
scripts/
  build.mjs     the build. Node stdlib only.
  dev.mjs       build plus a static file server. Node stdlib only.
  measure.mjs   the byte budgets and the XSS scan. Node stdlib only.
  measure-selftest.mjs  drives measure.mjs through the cases that must fail.
  check-page.mjs page behaviour, driven from Node with no browser.
dist/           build output. Gitignored: it embeds the anon key.
netlify.toml    build command, publish directory, and response headers.
```

`dist/config.js` is generated at build time from the two variables above and is
written with `JSON.stringify`, so a value cannot break out of the string
literal. `dist/` is gitignored for the same reason: the anon key lives there.

## Netlify

`netlify.toml` sets the build command to `node scripts/build.mjs` and the
publish directory to `dist`. Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the
Netlify build environment before the first deploy. The service-role key is not
needed and must not be set.

## License

MIT. See [LICENSE](LICENSE).