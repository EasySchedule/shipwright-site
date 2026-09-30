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
| `npm test` | Run the build script's tests. Node's built-in runner, no dependencies. |

Both are Node 20+. There is nothing to install: `npm install` is a no-op
because there is no `dependencies` block.

For local builds, copy the example environment file and fill in your own
values:

```sh
cp .env.example .env
```

## A known limitation in the minifier

The minifier strips comments and whitespace. It does not rename locals or fold
expressions, and it is not a JavaScript parser.

One consequence is worth knowing before you write page code. From a `/` on its
own it cannot always tell a division from a regex literal. After a `)`, `]` or
`}` on the same line, both readings are real, and it resolves them as a
division, then removes whitespace inside the run. Whitespace inside a pattern
is significant, so this changes what the pattern matches:

```js
if (1) / foo - bar /.test("foo-bar")   // false, and stays false in the build
if (1) /foo-bar/.test("foo-bar")       // true, which is what the bug produces
```

The mangled output still parses, so the build's `node --check` pass cannot catch
it. The build therefore refuses to publish that shape when the run's closing
`)`, `]` or `}` is on the same line: it prints the offending literal and exits 1
without writing `dist/`. If you hit that message, assign the left-hand side to a
variable first.

When the `/` starts the line, no guess is made. `minifyJs` copies the run byte
for byte instead, so there is nothing left for the guard to refuse. That is
deliberate, not an oversight, and it is also why the guard is not a complete
answer: it never sees these positions.

Both halves are documented where they are implemented rather than here. In
`scripts/build.mjs`, the `scanRegexRun` comment at lines 155-187 covers the
byte-for-byte copy, and the `findUnmangleableRuns` comment at lines 405-411
covers what the guard does and does not look at. Those comments are the
authoritative version of this section.

Fixing the remaining guessing properly needs a real lexer. That is a lot of code
to carry for a few kilobytes of first-party source, so it is a deliberate trade
for now, and `scripts/build.test.mjs` pins both the failure and the guard.

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
  build.test.mjs  tests for the build script. Node stdlib only.
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
