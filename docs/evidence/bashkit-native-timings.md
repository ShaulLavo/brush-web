# Native Bashkit timings

Chrome 154.0.8037.93, Apple M1, macOS 26.4 / Darwin 25.4.0, headless hardware WebGPU through Metal 3. Twenty trials after one warmup, alternating engine order. All outputs were checked.

| Workload | Engine | Worker, frame mode | Submitted frame, frame mode | Submitted frame, immediate mode |
| --- | --- | ---: | ---: | ---: |
| arithmetic-20000 | brush | 106.93 ms | 112.22 ms | 113.82 ms |
| arithmetic-20000 | just-bash | 105.13 ms | 112.07 ms | 113.77 ms |
| arithmetic-20000 | bashkit | 99.47 ms | 107.84 ms | 108.49 ms |
| arithmetic-20000 | bashkit-terminal | 101.36 ms | 106.47 ms | 107.51 ms |
| substitutions-1000 | brush | 48.20 ms | 59.69 ms | 59.30 ms |
| substitutions-1000 | just-bash | 66.73 ms | 71.30 ms | 72.43 ms |
| substitutions-1000 | bashkit | 21.57 ms | 29.05 ms | 29.59 ms |
| substitutions-1000 | bashkit-terminal | 29.96 ms | 37.82 ms | 42.13 ms |
| terminal-10000-settled | brush | 3.12 ms | 26.22 ms | 23.39 ms |
| terminal-10000-settled | just-bash | 7.88 ms | 33.39 ms | 30.76 ms |
| terminal-10000-settled | bashkit | 4.37 ms | 31.28 ms | 23.74 ms |
| terminal-10000-settled | bashkit-terminal | 14.44 ms | 38.08 ms | 39.24 ms |

The submitted-frame endpoint is Ghostty onFrame. It excludes compositor completion and physical display scanout. Worker spans are wall time through each adapter, not isolated interpreter CPU time. Cost instrumentation ran separately from the phase timings above.

## Both APIs in one WASM module

This control uses one worker, one source-built WASM module and the same execution-limit options. It excludes Ghostty, the shared bridge and page frame scheduling. Terminal uses its default 24 by 80 geometry. The workbench uses 27 by 136 and has eight live sessions during its matrix. Do not subtract these control medians from the workbench medians.

| Workload | Bash.execute | Terminal |
| --- | ---: | ---: |
| arithmetic-20000 | 62.93 ms | 63.56 ms |
| substitutions-1000 | 9.90 ms | 10.43 ms |
| terminal-10000 | 2.61 ms | 3.88 ms |

The Terminal differential includes native input editing, echo, the internal vt100 parser, transcript capture and different output extraction. It does not isolate vt100 or the WASM transition itself. The source-module SHA-256 is 07d2edc753c6e568bd5989b40ab103f5224a070abc9139b19f7dc9b61cc217c9.
