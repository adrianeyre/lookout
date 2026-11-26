# Changelog

## [1.3.0](https://github.com/adrianeyre/lookout/compare/v1.2.0...v1.3.0) (2026-11-26)

### Features

* **docker:** volumes under each Container, and delete unused ones ([e8673a9](https://github.com/adrianeyre/lookout/commit/e8673a9fdcaebb71c2b6ec8402ac0d651aa30847))

## [1.2.0](https://github.com/adrianeyre/lookout/compare/v1.1.0...v1.2.0) (2026-11-26)

### Features

* **stats:** site stats store, access-log visitors, uptime history and sizes ([035ec11](https://github.com/adrianeyre/lookout/commit/035ec11134bfb5880d74565225164da50df8a6c8)), closes [#6](https://github.com/adrianeyre/lookout/issues/6) [#7](https://github.com/adrianeyre/lookout/issues/7) [#8](https://github.com/adrianeyre/lookout/issues/8) [#9](https://github.com/adrianeyre/lookout/issues/9)
* **web:** Site Stats page, visitors on Websites and a Docker disk card ([19cb794](https://github.com/adrianeyre/lookout/commit/19cb794419ab844b291ab8b1b650a34cd889b3cf)), closes [#10](https://github.com/adrianeyre/lookout/issues/10) [#11](https://github.com/adrianeyre/lookout/issues/11)

## [1.1.0](https://github.com/adrianeyre/lookout/compare/v1.0.0...v1.1.0) (2026-11-26)

### Features

* **settings:** change the password from Settings ([c852064](https://github.com/adrianeyre/lookout/commit/c8520647ebbcf18683912ad9cd6a28e044186898))
* **sites:** judge short-lived certificates by their lifetime ([c55d5ff](https://github.com/adrianeyre/lookout/commit/c55d5ffa9c842126420c65de0af26c2eb559e316))
* **web:** collapsible Compose Projects, busiest interfaces first, back button ([64eb5b4](https://github.com/adrianeyre/lookout/commit/64eb5b46f59c1485edc4d7a120ceb929d72d37de))

### Bug Fixes

* **ci:** backdate the e2e certificate and leave CHANGELOG.md to semantic-release ([3784576](https://github.com/adrianeyre/lookout/commit/37845765308e72ab96da487a123c1c66c2ad4a2e))

## 1.0.0 (2026-11-26)

### Features

* initial import of Lookout ([68f7fc4](https://github.com/adrianeyre/lookout/commit/68f7fc45c02b3a97454311512594a411e160f780))

### Bug Fixes

* **ci:** let the release gate run with no pen-test round open ([08c9bed](https://github.com/adrianeyre/lookout/commit/08c9beddd9a8e8c38c446b2a4d9a981d2b5d3d69)), references [#75](https://github.com/adrianeyre/lookout/issues/75)
* **ci:** write the release version without npm ([467d1c2](https://github.com/adrianeyre/lookout/commit/467d1c2288c0aa7ca5b706680328f3eda051ba73))
