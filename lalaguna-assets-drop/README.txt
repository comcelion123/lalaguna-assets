lalaguna-assets - what goes where
=================================

Drop these into the ROOT of comcelion123/lalaguna-assets, keeping the folders:

  lalaguna-studio__CEDAIN-intro-module-v2.js   the glass gate, now standing in the environment
  Neoda-v3.typeface.js                         the glass CEDAIN wordmark's typeface (was missing: the
                                               gate fell back to Helvetiker)
  city/                                        the whole folder - tiles, ground-atlas-v2.png,
                                               valley-field-v2.png, lattice-sky.png, city-manifest.json
  env/                                         EMPTY until the panorama is rendered. Then put
                                               pano_dusk.jpg and pano_dusk_sky.png here (and the golden
                                               pair if you want to switch: footer LALA_CONFIG.env.pano)

jsDelivr serves a NEW filename at once and caches an UPDATED one for ~12 hours,
which is why files that changed carry a new name (-v2). To check what is live,
open the URL in a browser tab:
  https://cdn.jsdelivr.net/gh/comcelion123/lalaguna-assets@main/city/ground-atlas-v2.png
