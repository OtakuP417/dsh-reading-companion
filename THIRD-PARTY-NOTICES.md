# Third-party notices / 第三方声明

`dsh-reading-companion` is MIT-licensed (see [LICENSE](LICENSE)). It bundles or
imports the following MIT-licensed work:

## foliate-js

- Files: `vendor/foliate-js/**`, compiled into `lib/client.js`
- License: MIT, Copyright (c) 2022 John Factotum
- Source: <https://github.com/johnfactotum/foliate-js>
- Used for: EPUB rendering (paginator, CFI resolution, overlays) in the reader
  pane. `lib/client.js` is a bundle of our client code plus this library, so the
  notice travels with the shipped artifact.

## supermemo2

- Files: `vendor/supermemo2/**`, imported by `src/shared/scheduler.js` and
  compiled into `lib/index.js`
- License: MIT, Copyright (c) 2016 Niven Su
- Source: <https://www.npmjs.com/package/supermemo2>
- Used for: the SuperMemo-2 spaced-repetition scheduling used by the review
  layer. We do not reimplement the algorithm; this package is the scheduler.

## Build-time only

`esbuild` (MIT) compiles `src/**` into `lib/**`; `react` / `react-dom` (MIT) are
used by the test harness. None of them are bundled into the published
artifacts — `react` is resolved from the DSH client's own module table at
runtime.
