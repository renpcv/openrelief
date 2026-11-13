# OpenRelief

An open-source bas-relief generator. Import 3D models, pick a viewing angle, and
get a shallow, overhang-free relief ready for CNC, 3D printing, engraving or
displacement mapping. It runs entirely in the browser; nothing is uploaded.

Live version: https://renpcv.github.io/openrelief/

## Run it

```bash
npm install
npm run dev
```

Then open the printed URL. `npm test` runs the unit tests and `npm run build`
produces a static site in `dist/` that can be hosted anywhere.

## The source download

The page's "Download source code" link serves `openrelief-source.zip`, which
holds a `source/` copy of the project and a ready-to-host `web/` copy of the
built page. `npm run build` rebuilds it (via `build-zip.mjs`); run that before
publishing so the download matches the code.

## Publishing

`npm run deploy` builds the page and pushes `dist/` to the repository's
`gh-pages` branch, which GitHub Pages serves.

## What it does

- **Import** OBJ and STL (button or drag and drop), several models per scene.
- **Compose**: move, rotate and scale each model (a slider scales evenly);
  orbit to any view. The relief is taken from the current camera direction.
- **Generate** at 512 to 8192 px on the long side:
  - *Compressed* - true bas-relief. Depth is squeezed non-linearly so the piece
    stays shallow while overlaps and fine detail remain readable.
  - *Raw geometry* - a plain linear depth scale.
  - Controls for depth compression, contour prominence (the step where a model
    meets the background), inner edge prominence (steps where one part passes
    in front of another), detail emphasis, smoothing and margin.
- **Size** the result in millimetres: long side, relief depth, base plate, and
  raised or sunken. Depth and base plate scale with the long side by default,
  so the piece keeps its proportions. Hollows that end up deeper than the background (the inside
  of an open box, say) keep their shape and sit below the background plane.
- **Export** a watertight STL or OBJ solid, a 16-bit PNG depth map, or 32-bit
  float EXR / PFM depth maps.

## How it works

1. `src/viewport.ts` renders the scene's depth with an orthographic camera into
   a float texture (in tiles, so the output can exceed the GPU texture limit).
2. `src/relief/relief.ts` takes the gradients of that height field, replaces
   depth discontinuities with small controlled steps, compresses the remaining
   slopes with `s -> log(1 + a*s) / a`, and
3. `src/relief/poisson.ts` integrates the modified gradients back into a height
   field by solving a Poisson equation with the background pinned flat
   (conjugate gradients preconditioned by aggregation multigrid), in a worker.
4. `src/export/` turns the result into meshes and depth maps.

## References

The relief method follows published research on gradient-domain bas-relief.
The code follows the approach of these papers; it is not a line-by-line
implementation of any one of them.

- T. Weyrich, J. Deng, C. Barnes, S. Rusinkiewicz, A. Finkelstein.
  *Digital Bas-Relief from 3D Scenes.* ACM Transactions on Graphics 26(3)
  (Proc. SIGGRAPH), 2007. The main source: working on depth gradients, turning
  silhouettes and occlusion edges into controlled steps, and compressing slopes
  with a log curve.
  [Project page](https://reality.cs.ucl.ac.uk/projects/relief/relief.html) -
  [PDF](https://gfx.cs.princeton.edu/pubs/Weyrich_2007_DBF/relief.pdf)
- J. Kerber, A. Tevs, A. Belyaev, R. Zayer, H.-P. Seidel.
  *Feature Sensitive Bas Relief Generation.* IEEE International Conference on
  Shape Modeling and Applications (SMI), 2009, pp. 148-154. Informed the
  detail-emphasis step.
  [DOI 10.1109/SMI.2009.5170176](https://doi.org/10.1109/SMI.2009.5170176) -
  [PDF](https://hpdgp.mpi-inf.mpg.de/pappe/br2009.pdf)
- R. Fattal, D. Lischinski, M. Werman.
  *Gradient Domain High Dynamic Range Compression.* ACM Transactions on
  Graphics 21(3) (Proc. SIGGRAPH), 2002, pp. 249-256. The origin of the
  "compress the gradients, then solve a Poisson equation" idea that the
  bas-relief papers build on.
  [Project page](https://www.cs.huji.ac.il/~danix/hdr/)

Also built on:

- **Solver.** Conjugate gradients preconditioned by aggregation multigrid:
  standard numerical methods rather than a specific paper. General background:
  W. Briggs, V. E. Henson, S. McCormick, *A Multigrid Tutorial*, 2nd ed.,
  SIAM, 2000.
- **Smoothing.** A Gaussian blur approximated by three box-filter passes, a
  common image-processing technique.
- **3D view and file loading.** [three.js](https://threejs.org) (MIT licence),
  including its OBJ and STL loaders and its orbit and transform controls.
- **Export formats.** Written from their published specifications:
  [PNG](https://www.w3.org/TR/png/),
  [OpenEXR file layout](https://openexr.com/en/latest/OpenEXRFileLayout.html),
  [PFM](https://www.pauldebevec.com/Research/HDR/PFM/), and the widely
  documented binary STL and Wavefront OBJ formats.

## Roadmap

- STEP export (heightfield as a B-spline surface)
- Per-model relief settings and model alignment / distribution tools
- Height-map and normal-map import as scene elements
- Backplate reference images
- Project save / load
- Edge-aware (bilateral) detail layers; slope limiting for a given tool angle
- GPU (WebGPU) solver for faster 4K-16K output
- Perspective capture

## License

MIT - see [LICENSE](LICENSE).
