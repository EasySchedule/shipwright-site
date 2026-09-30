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

Both are Node 20+. There is nothing to install: `npm install` is a no-op
because there is no `dependencies` block.

For local builds, copy the example environment file and fill in your own
values:

```sh
cp .env.example .env
```

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