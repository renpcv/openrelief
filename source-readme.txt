OPENRELIEF - SOURCE CODE
========================

Turns 3D models into bas-reliefs for CNC, 3D printing and engraving, in a web
browser. Models stay on your computer and are never uploaded.
This download holds the tool in two forms.


source/  RUN IT OR CHANGE IT ON YOUR OWN COMPUTER
-------------------------------------------------
The full project, as TypeScript.

1. Install Node.js (free, from https://nodejs.org). Any recent version works.
2. Open a terminal in the source folder and run:
       npm install
       npm run dev
   Then open the address it prints (usually http://localhost:5173).
   Keep the terminal open while you use the page. Close it to stop.

Other commands:
   npm test         runs the unit tests
   npm run build    builds the page into dist/ and rebuilds this zip
   npm run deploy   builds, then publishes dist/ to the gh-pages branch of
                    your own GitHub repository (the "origin" remote)


web/  PUT IT ONLINE
-------------------
The built page, so anyone can open it by link without installing anything.

Upload the contents of the web folder to any static web host, for example:
- GitHub Pages: create a repository, upload the files, then turn on
  Settings > Pages > Deploy from a branch.
- Netlify: drag the web folder onto https://app.netlify.com/drop

It won't work if you open index.html directly as a file; it has to be served.

The page has a "Download source code" link. On your copy it needs this zip:
put openrelief-source.zip in the web folder next to index.html, or the link
won't work.


USING THE PAGE
--------------
1. Import OBJ or STL models (button, or drag them onto the page), or try the
   demo model.
2. Drag to orbit, right-drag to pan, scroll to zoom. Click a model to select
   it, then move, rotate or scale it (the Uniform scale slider scales evenly).
   The relief is taken from the current view.
3. Adjust the relief settings and press "Generate relief".
4. Set the size in millimetres and export STL, OBJ, PNG, EXR or PFM.


CHANGING IT
-----------
- src/style.css            colours, sizes, layout
- index.html               the controls
- src/main.ts              ties the controls to everything else
- src/viewport.ts          3D view, model handling, depth capture
- src/relief/relief.ts     the relief algorithm
- src/relief/poisson.ts    the solver it uses
- src/export/              mesh and depth-map writers

REFERENCES
----------
The relief method follows published research on gradient-domain bas-relief.
The code follows the approach of these papers; it is not a line-by-line
implementation of any one of them.

- T. Weyrich, J. Deng, C. Barnes, S. Rusinkiewicz, A. Finkelstein.
  "Digital Bas-Relief from 3D Scenes." ACM Transactions on Graphics 26(3)
  (Proc. SIGGRAPH), 2007.
  The main source: working on depth gradients, turning silhouettes and
  occlusion edges into controlled steps, and compressing slopes with a log
  curve.
  https://reality.cs.ucl.ac.uk/projects/relief/relief.html
  https://gfx.cs.princeton.edu/pubs/Weyrich_2007_DBF/relief.pdf

- J. Kerber, A. Tevs, A. Belyaev, R. Zayer, H.-P. Seidel.
  "Feature Sensitive Bas Relief Generation." IEEE International Conference on
  Shape Modeling and Applications (SMI), 2009, pp. 148-154.
  Informed the detail-emphasis step.
  https://doi.org/10.1109/SMI.2009.5170176
  https://hpdgp.mpi-inf.mpg.de/pappe/br2009.pdf

- R. Fattal, D. Lischinski, M. Werman.
  "Gradient Domain High Dynamic Range Compression." ACM Transactions on
  Graphics 21(3) (Proc. SIGGRAPH), 2002, pp. 249-256.
  The origin of the "compress the gradients, then solve a Poisson equation"
  idea that the bas-relief papers build on.
  https://www.cs.huji.ac.il/~danix/hdr/

Also built on:

- Solver: conjugate gradients preconditioned by aggregation multigrid.
  Standard numerical methods rather than a specific paper. General background:
  W. Briggs, V. E. Henson, S. McCormick, "A Multigrid Tutorial", 2nd ed.,
  SIAM, 2000.
- Smoothing: a Gaussian blur approximated by three box-filter passes, a common
  image-processing technique.
- 3D view and file loading: three.js (MIT licence), including its OBJ and STL
  loaders and its orbit and transform controls. https://threejs.org
- Export formats, written from their published specifications:
    PNG       https://www.w3.org/TR/png/
    OpenEXR   https://openexr.com/en/latest/OpenEXRFileLayout.html
    PFM       https://www.pauldebevec.com/Research/HDR/PFM/
    and the widely documented binary STL and Wavefront OBJ formats.


Licence: MIT (see source/LICENSE). More detail in source/README.md.
