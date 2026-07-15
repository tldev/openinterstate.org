# openinterstate.org

Website and docs for OpenInterstate.

## Stack

- Astro
- Cloudflare Workers static asset delivery

## Site

1. home
2. data
3. releases
4. about
5. contribute

## Development

```bash
npm install
npm run dev
```

## Production Build

```bash
npm run build
```

## Deployment

Production deploys target the `openinterstate.org` and `www.openinterstate.org`
custom domains through a Cloudflare Worker that serves the static Astro build.

```bash
npm run deploy
```
