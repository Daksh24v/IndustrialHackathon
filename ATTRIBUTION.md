# Data sources and licences

Every building's `building.json` names its own source, licence and attribution, and so does `manifest.csv`. The licences differ by source:

| Source (`source`) | Licence | Attribution | What we changed |
|---|---|---|---|
| `swiss_dwellings` | CC BY 4.0 | Swiss Dwellings, Standfest et al. / Archilyse, https://zenodo.org/records/7070952 | Converted to our format. Added the shared stair halls (recovered from gaps in the plan), stair and lift cores, building entrances and generated furniture. Every addition is marked `synthetic: true` or `source: generated`. |
| `resplan` | CC BY 4.0 | ResPlan, Agour et al., https://github.com/m-agour/ResPlan | Rescaled to metres, added hallways and door connectivity, and generated furniture. |
| `osm_indoor` | ODbL 1.0 | © OpenStreetMap contributors, https://www.openstreetmap.org/copyright | Projected to local metres and split per level. Added fallback doors where none were mapped, small lift spaces for lifts mapped as nodes, and generated furniture. **This part of the dataset is a derived database under the ODbL. If you share it, it stays under the ODbL.** |
| `procedural` | CC0 1.0 | Generated for the Munich hackathon | Everything is generated. |

Furniture with `source: generated` comes from rules in `config/furniture_catalog.yaml`. Fixtures with `source: dataset` come from the original data.

## Map surroundings (`data/context/`)

The neighbourhood drawn around a building (nearby buildings with heights, roads and rail, green areas and water) comes from OpenStreetMap: ODbL 1.0, © OpenStreetMap contributors, https://www.openstreetmap.org/copyright. `scripts/osm_context.py` fetched it once from the Overpass API and baked it into `data/context/<building_id>.json`: projected to the building's local metres, clipped to 500 m, simplified, and with the OSM buildings under our own footprint removed. **These files are a derived database under the ODbL. If you share them, they stay under the ODbL, and the map must show the credit "© OpenStreetMap contributors".** Each file carries its `attribution` and `license`.

`data/context/placements.json` says where each building stands. Buildings from OSM are fitted onto their own OSM outline. The procedural factory `proc-factory-dev-003` is fictional: we placed it on a real empty brownfield lot (Am Moosfeld, Munich-Trudering-Riem) so it has real neighbours. Nothing is built there.
