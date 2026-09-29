# Architectural Blueprint Specification: High-Fidelity Procedural Asset Pipeline
**Document Version:** 1.0.0  
**Project:** Procedural Jerusalem (`procedural-city`)  
**Target Branch:** `main-twlqs0`  
**Role:** Lead Technical Art & Code Architect  
**Status:** Approved for Phased Implementation  

---

## Executive Summary & Visual Direction

The `procedural-city` engine currently achieves remarkable scale, procedural streaming, and simulation performance in WebGL. However, its visual assets—vehicles, pedestrians, street furniture, market stalls, and architectural dressings—remain largely first-order geometric primitives ("programmer art"): single stretched box geometries, flat planar strips, and low-polygon cylinders.

This document establishes the definitive **Technical Art and Procedural Asset Specification**. It details a multi-part recursive hierarchy for all urban asset categories, transitioning the game from low-fidelity placeholders to a museum-grade, stylized-realistic portrayal of Jerusalem's unique Mediterranean vernacular.

### Core Architectural Mandates:
1. **Elimination of Programmer Art:** Replace single-volume boxes with hierarchical, compound-part assemblies featuring realistic silhouettes, chamfers, bevels, depth recesses, and authentic material articulation.
2. **Strict Draw-Call Ceiling (< 450 Total Draw Calls):** WebGL rendering performance hinges on batching. Under peak loads (full camera frustum over downtown Jerusalem, heavy market traffic, light rail, pedestrians, and streaming tiles), total scene draw calls must remain strictly below **450** at 60 FPS on mid-tier hardware.
3. **Compound Pre-Baked Geometry vs. Instanced Part Kits:** Leverage static attribute baking (packing material roughness, metalness, vertex tint, and ambient occlusion into vertex buffers) merged into single `InstancedMesh` units for dynamic actors, and reusable modular palette kits for complex static assemblies like souks and storefronts.
4. **Authentic Jerusalem Aesthetics:** Faithful reflection of regional characteristics: Mea Shearim / Haredi pedestrian silhouettes, golden-hour limestone reflectance, authentic Citadis 302 light rail modules, authentic Mahane Yehuda produce/spice arrangements, iconic rooftop solar heaters (*Dud Shemesh*), and Mediterranean flora (Italian Cypress and gnarled ancient Olives).

---

## 1. Codebase Audit: Current Asset Pipelines & Bottlenecks

### 1.1 Traffic & Vehicles (`src/city/TrafficSystem.js`)
* **Current Implementation:**
  * `carGeometry()`: 1 chassis box (`1.75 x 0.6 x 4.3`), 1 cabin glass box, 1 thin roof plate, 4 headlight/taillight quad boxes, 4 ten-segment cylinders for wheels. Total ~180 vertices.
  * `vanGeometry()`: 2 compound boxes (cargo cabin + nose), 1 flat windshield box, lights, 4 cylinder wheels. Total ~210 vertices.
  * `tramModuleGeometry()`: 1 large monolithic box (`2.65 x 2.3 x 6.6`), a horizontal glass band box, a red trim box, a roof AC box, and light quads.
* **Draw-Call & Material Footprint:**
  * Car: 1 `InstancedMesh` with custom `MeshStandardMaterial` (`uNight` emissive injection).
  * Van: 1 `InstancedMesh` using the same material.
  * Tram: 1 `InstancedMesh` for 5 articulated modules.
  * Headlight Cones: 1 `InstancedMesh` with additive `ShaderMaterial`.
  * Steel Rails: 1 static `Mesh` with environment reflection mapping.
* **Visual Deficiencies:**
  * Vehicles lack wheel wells, wheel hubs/rims, side mirrors, bumpers, license plates, windshield pillars (A/B/C pillars), curved hoods, and interior cabin depth.
  * Trams resemble floating extruded shipping containers rather than sleek Alstom Citadis units with panoramic glass and aerodynamic front noses.

### 1.2 Street Props & Market Stalls (`src/city/StreetProps.js`, `src/city/landmarks/stalls.js`)
* **Current Implementation:**
  * Props in `StreetProps.js`: Lanterns (stacked cylinders + cone cap), stone benches (3 intersecting boxes), bollards (cylinder + sphere), Italian cypress (stacked 7-sided frustums), and olive trees (forked cylinder limbs + 4 icosahedron foliage clouds).
  * Stalls in `stalls.js`: `createStallKit()` defines 10 unit parts (`counter`, `crate`, `heap`, `sack`, `bowl`, `cone`, `block`, `panel`, `card`, `umbrella`), rendered via separate `InstancedMesh` instances grouped per part type.
* **Draw-Call & Material Footprint:**
  * Street props are batched per streaming chunk using chunked `InstancedMesh` layers (`Lanterns`, `Benches`, `Bollards`, `Cypresses`, `Olives`, `LampPools`).
  * Market stalls execute ~10 draw calls across the entire market layer (`createGoodsMaterial()`).
* **Visual Deficiencies:**
  * Stalls: Display counters are unadorned sloping polygons. Produce heaps are uniformly distorted half-spheres. Spice cones lack powder micro-texture and brass rim definition. Awnings and umbrellas lack draped fabric tension, rib lines, and scalloped edges.
  * Street Furniture: Stone benches have sharp 90° digital edges without stone dressing, chisel marks, or wood-slat options. Street lanterns lack ornamental ironwork scroll brackets (*filigree*) characteristic of Jaffa Road and the Old City gates.

### 1.3 Pedestrians (`src/city/PedestrianSystem.js`, `src/city/RiggedPedestrians.js`)
* **Current Implementation:**
  * Low-poly mannequin (`createPedestrianMesh`): 6-sided cylinder prisms for torso, neck, arms, and legs; faceted icosahedron head; non-indexed geometry with `aPart` and `aZone` vertex attributes.
  * Dynamic animation: Vertex shader vertex displacement (`pedSwing`) calculates harmonic arm/leg swing based on stride cadence in `aWalk`.
  * Rigged models (`RiggedPedestrians.js`): Distance-based hysteresis loads a rigged GLTF model (`character.glb`) for foreground actors.
* **Draw-Call & Material Footprint:**
  * 1 `InstancedMesh` draw call for all crowd mannequins (up to 340 agents).
  * 1 depth pass draw call for custom shadow swing.
  * 1-2 draw calls for rigged GLTF models.
* **Visual Deficiencies:**
  * Mannequins have robotic, faceted anatomy with no clothing folds, shoe soles, lapels, tzitzit tassels, head coverings (kippot, kaffiyehs, hats), or accessories (bags, phones, market baskets).
  * Female and child silhouettes are absent; all crowd members share identical masculine mannequin proportions.

### 1.4 Buildings & Storefronts (`src/city/CityGenerator.js`, `src/city/Awnings.js`)
* **Current Implementation:**
  * Procedural extruded 2.5D polygons with procedural world-space facade shaders (`createStoneMaterial`). Window reveals, arches, and shopfronts are drawn entirely in the fragment shader via procedural signed-distance functions (SDF).
  * Ground-floor awnings (`Awnings.js`): Single sloping quad geometry with front valance and side cheeks, instanced along shop bays.
  * Rooftop props: Single merged `solarHeaterGeometry` (cylinder tank + tilted panel box + frame box) and simple scaled cubes for AC units.
* **Draw-Call & Material Footprint:**
  * 1 merged `Buildings` mesh per chunk (draw call count = 1 per active chunk).
  * 1 `AwningsStriped` and 1 `AwningsSolid` `InstancedMesh` per chunk.
  * 1 `SolarHeaters` and 1 `AcUnits` `InstancedMesh` per chunk.
* **Visual Deficiencies:**
  * Storefronts rely on flat shader textures without true geometric depth: no recessed entry doorways, no extruded window frames, no physical roll-down shutter boxes, and no physical 3D signage or projecting hanging shop lanterns.
  * Rooftop AC compressors are plain untextured cubes with zero grille detailing, fan indents, or mounting bracket geometry.

---

## 2. Recursive Component Breakdown: Multi-Part Hierarchies

Every asset category is partitioned into a four-tier recursive hierarchy:
$$\text{Component} \longrightarrow \text{Sub-component} \longrightarrow \text{Micro-component} \longrightarrow \text{Fine-detail elements}$$

All dimensions are in **meters ($m$)**, angles in **radians**, and local axes adhere to:
* $+X$: Lateral / Right
* $+Y$: Vertical / Up
* $+Z$: Longitudinal / Forward (or outward facing)

---

### 2.1 Urban Vehicles & Transit

```
Vehicle Asset
├── 1.0 Chassis & Powertrain Assembly
│   ├── 1.1 Lower Floor Pan & Undercarriage
│   ├── 1.2 Front & Rear Wheel Wells (Arch Cutouts)
│   └── 1.3 Dual Exhaust Tips & Diffuser Recess
├── 2.0 Body Shell & Greenhouse (Cab)
│   ├── 2.1 Monocoque Lower Body (Fenders, Rocker Panels)
│   ├── 2.2 Aerodynamic Hood & Trunk Deck
│   ├── 2.3 Greenhouse Pillars (A, B, C Pillars) & Roof Shell
│   └── 2.4 Deep-Tint Flush Glazing (Windshield, Rear, Sides)
├── 3.0 Front & Rear Fascia
│   ├── 3.1 Radiator Grille Mesh & Lower Air Dam
│   ├── 3.2 Polycarbonate Headlight Housings with Projector Lenses
│   ├── 3.3 LED Lightbar / Segmented Taillight Lenses
│   └── 3.4 Bumper Bars & Recessed License Plate Plinths
├── 4.0 Running Gear (x4 Wheels)
│   ├── 4.1 Low-Aspect Treaded Rubber Tire
│   ├── 4.2 Multi-Spoke Alloy Wheel Rim
│   ├── 4.3 Center Wheel Cap & Lug Nuts
│   └── 4.4 Brake Disc Rotor & Caliper
└── 5.0 Ergonomic & Aerodynamic Trim
    ├── 5.1 Aerodynamic Wing Mirrors (L/R)
    ├── 5.2 Recessed Door Handles (x2 or x4)
    └── 5.3 Roof Rails / Shark Fin Antenna
```

#### Detailed Specification: Contemporary Sedan / Hatchback ($4.45\text{ m} \times 1.82\text{ m} \times 1.46\text{ m}$)

| Node ID | Part Name | Geometry Primitive | Dimensions ($w, h, d$) / Offsets $[x, y, z]$ | Material & PBR Attributes |
| :--- | :--- | :--- | :--- | :--- |
| **1.1** | Undercarriage Pan | `BoxGeometry` | $[1.60, 0.12, 4.10]$, offset $[0.0, 0.18, 0.0]$ | Matte Undercoat: `#111112`, Roughness: `0.95`, Metal: `0.1` |
| **1.2** | Wheel Wells (x4) | Beveled Ring Subtractions | $r_{\text{inner}}=0.36, r_{\text{outer}}=0.42$, offsets $[\pm 0.82, 0.36, \pm 1.35]$ | Dark Matte Shield: `#18181a`, Roughness: `0.9` |
| **2.1** | Lower Body Flanks | Compound Lozenge Extrusion | $[1.78, 0.52, 4.38]$, offset $[0.0, 0.48, 0.0]$ | Gloss Clearcoat: `aColor` (Instance), Roughness: `0.18`, Metal: `0.75` |
| **2.2a**| Front Hood (Bonnet) | Beveled Wedge Box | $[1.52, 0.18, 1.25]$, slope $8.5^\circ$, offset $[0.0, 0.74, 1.22]$ | Body Clearcoat: `aColor`, Roughness: `0.18`, Metal: `0.75` |
| **2.2b**| Trunk Lid (Boot) | Flat Chamfered Box | $[1.48, 0.14, 0.78]$, offset $[0.0, 0.88, -1.65]$ | Body Clearcoat: `aColor`, Roughness: `0.18`, Metal: `0.75` |
| **2.3** | A/B/C Pillars | Tapered Hex Prisms | Width $0.08$, offsets $A:[\pm 0.68, 1.12, 0.45], B:[\pm 0.72, 1.15, -0.22]$ | Satin Black Polyurethane: `#1c1d1f`, Roughness: `0.45` |
| **2.4a**| Windshield | Raked Curved Plate | $[1.42, 0.68, 0.04]$, pitch $38^\circ$, offset $[0.0, 1.12, 0.52]$ | Dielectric Glass: `#121820`, Opacity: `0.85`, Rough: `0.05`, Metal: `0.9` |
| **2.4b**| Rear Window | Raked Curved Plate | $[1.36, 0.58, 0.04]$, pitch $-32^\circ$, offset $[0.0, 1.14, -1.18]$ | Dark Privacy Glass: `#0d1014`, Opacity: `0.92`, Rough: `0.05`, Metal: `0.9` |
| **3.1** | Front Honeycomb Grille | Perforated Inset Box | $[0.95, 0.28, 0.08]$, offset $[0.0, 0.48, 2.18]$ | Textured Matte Plastic: `#1e1e1e`, Roughness: `0.8`, Metal: `0.0` |
| **3.2** | Headlight Clusters (x2) | Angled Faceted Prisms | $[0.36, 0.16, 0.12]$, offsets $[\pm 0.64, 0.64, 2.12]$ | Housing: `#f5f8fc`, `aLight=1`, Emissive Night: $12.0\text{ cd/m}^2$ |
| **3.3** | LED Taillight Bar | Segmented C-Ribbon | $[1.56, 0.12, 0.06]$, offset $[0.0, 0.78, -2.18]$ | Ruby Polycarbonate: `#800508`, `aLight=2`, Emissive Night: $5.0\text{ cd/m}^2$ |
| **3.4** | License Plates (F/R) | Chamfered Plate | $[0.52, 0.12, 0.02]$, offsets $[0.0, 0.38, 2.21]$ and $[0.0, 0.54, -2.21]$ | Israeli Yellow Reflective: `#f2c20c`, Text Stamp: `#111` |
| **4.1** | Tires (x4) | 12-segment Chamfer Cylinder | $r=0.32, w=0.22$, offsets $[\pm 0.84, 0.32, \pm 1.35]$ | Vulcanized Rubber: `#1a1a1a`, Roughness: `0.88`, Metal: `0.0` |
| **4.2** | 5-Spoke Alloy Rims (x4) | Extruded Star Cylinder | $r=0.22, w=0.06$, offsets $[\pm 0.86, 0.32, \pm 1.35]$ | Machined Aluminum: `#d8dce2`, Roughness: `0.22`, Metal: `0.92` |
| **4.4** | Brake Rotors & Calipers | Thin Disc + Offset Block | $r=0.17, t=0.015$, caliper at top-dead-center | Cast Iron: `#74777d`, Caliper Sport Red: `#cc1a1a` |
| **5.1** | Wing Mirrors (L/R) | Aerodynamic Tear-Pod | $[0.18, 0.12, 0.22]$, offsets $[\pm 0.88, 0.98, 0.48]$ | Body Paint Top, Mirror Chrome Glass Interior face |

#### Detailed Specification: Jerusalem Light Rail (Alstom Citadis 302 Articulated Tram)
* Five articulated modules ($32.5\text{ m}$ total length, $2.65\text{ m}$ width, $3.40\text{ m}$ height):
  1. **Cab End Modules (x2):** Aerodynamic curved nose cone ($15^\circ$ slope), wrap-around single-piece panoramic cab windscreen, high-mounted LED route matrix display (*"חיל האוויר / הר הרצל"*), roof-mounted fairings covering air conditioning modules, and recessed anti-climber crash buffers.
  2. **Passenger Car Modules (x3):** Double-leaf flush sliding passenger plug-doors ($1.30\text{ m}$ clear width), continuous tinted panoramic window ribbons with black ceramic frit border printing, extruded roof cowlings concealing HVAC and pantograph linkage, and articulated accordion bellows joints between modules.

---

### 2.2 Market Stalls & Souk Architecture (Mahane Yehuda & Old City)

```
Market Stall Assembly
├── 1.0 Structural Timber & Iron Framework
│   ├── 1.1 Square Tubular Steel / Pine Corner Posts (x4)
│   ├── 1.2 Cross-Bracing Struts & Header Lintels
│   └── 1.3 Overhead Retractable Cantilever Awning Arms
├── 2.0 Base Cabinetry & Stepped Tiers
│   ├── 2.1 Rustic Marine-Plywood / Metal Base Plinth
│   ├── 2.2 Triple-Stepped Cascading Display Risers (Tiers 1, 2, 3)
│   └── 2.3 Lower Burlap-Draped Storage Sump
├── 3.0 Containerization & Display Modules
│   ├── 3.1 Injection-Molded Perforated Produce Crates (Plastic)
│   ├── 3.2 Spun Brass & Hammered Copper Bowls
│   ├── 3.3 Coarse Woven Jute / Burlap Sacks with Rolled Rims
│   └── 3.4 Tiered Wire Baskets & Slotted Baguette Crates
├── 4.0 Articulated Merchandise Clusters
│   ├── 4.1 Pyramidal Citrus & Pomegranate Stacks
│   ├── 4.2 Smooth Hand-Sculpted Spice Cones (Sumac, Za'atar, Turmeric)
│   ├── 4.3 Cylindrical Halva Wheels & Segmented Slices
│   └── 4.4 Suspended Macrame Textiles & Hanging Ceramic Lanterns
└── 5.0 Visual Merchandising & POS Props
    ├── 5.1 Handwritten Chalkboard / Laminated Price Stakes
    ├── 5.2 Overhead Bare Filament Edison Bulbs / Industrial Halogen
    └── 5.3 Hanging Balance-Beam Produce Scale with Brass Pan
```

#### Detailed Specification: Fresh Produce & Citrus Stall ($2.80\text{ m} \times 1.40\text{ m} \times 2.45\text{ m}$)

| Node ID | Part Name | Geometry Primitive | Relative Transform $[x, y, z]$ / Dimensions | PBR Material Definition |
| :--- | :--- | :--- | :--- | :--- |
| **1.1** | Corner Uprights (x4) | Square Box Beams | $[0.06, 2.40, 0.06]$ at $[\pm 1.35, 1.20, -0.65 / +0.65]$ | Weathered Olive Pine: `#3a2a1a`, Roughness: `0.85` |
| **1.3** | Awning Frame | Angled Strut Box | Pitch $18^\circ$, extension $1.2\text{ m}$ forward | Painted Tubular Steel: `#2a2b2e`, Metal: `0.6` |
| **2.1** | Base Cabinet | Heavy Plank Box | $[2.70, 0.65, 1.30]$, offset $[0.0, 0.325, 0.0]$ | Reclaimed Wood Siding: `#4d3b2c`, Bump: Woodgrain |
| **2.2** | 3-Tier Step Riser | Tri-Step Prism | Steps: rise $0.18\text{ m}$, run $0.38\text{ m}$, tilt $12^\circ$ | Raw Plywood Edge: `#c4a478`, Roughness: `0.75` |
| **3.1** | Stacked Crates (x18) | Hollow Molded Box | $[0.42, 0.22, 0.34]$, rib thickness $0.02\text{ m}$ | High-Density Polyethylene: Red (`#ab1f1a`), Green (`#1e6b32`), Blue (`#1a458a`), Rough: `0.4` |
| **4.1a**| Orange / Citrus Mounds| Packed Octahedra Stack | 3-tier pyramid ($4 \times 3 \rightarrow 3 \times 2 \rightarrow 2 \times 1$), $r=0.065$ | Jaffa Orange Waxed Rind: `#e86f10`, Subsurface Scatter |
| **4.1b**| Pomegranate Mound | Segmented Cluster | Clustered spheres with crown calyx, $r=0.075$ | Deep Crimson Glaze: `#780d19`, Roughness: `0.28` |
| **5.1** | Slanted Price Cards | Chamfered Card on Wire | Card $[0.14, 0.09, 0.003]$, Wire $l=0.18, r=0.002$ | Matte Cardstock: Off-White `#faf8f2`, Red Marker Accent |
| **5.2** | Bare Filament Lamps | Drop Cord + Pear Bulb | Drop $0.65\text{ m}$, Bulb $r=0.045$, offset $y=2.15$ | Brass Fitting: `#c89f48`, Glass Filament Emissive: $25\text{ cd/m}^2$ |

#### Detailed Specification: Old City Souk Spice & Dry Goods Stall
* **Spice Vessels:** Spun copper and hammered brass wide-mouth hemispherical bowls ($r=0.28\text{ m}, h=0.18\text{ m}$) resting on ring stands.
* **Spice Cones:** Steep cones ($r=0.24\text{ m}, h=0.48\text{ m}$, tilt $4^\circ$) exhibiting velvety matte finishes:
  * Sumac: Deep Burgundy `#61121d`, ultra-matte roughness `0.98`.
  * Turmeric: Intense Gold-Orange `#e59a12`, roughness `0.95`.
  * Za'atar: Herbaceous Thyme Green-Brown `#4d4f29`, roughness `1.0`.
* **Sacks:** Loosely folded lathe geometry with rolled fabric cuffs; burlap texture with frayed edges and filled with textured almond, pistachio, and dried hibiscus geometries.

---

### 2.3 Pedestrian Population & Cultural Articulation

```
Pedestrian Asset
├── 1.0 Skeletal-Proportional Core
│   ├── 1.1 Cranium, Facial Plane & Cervical Column (Head/Neck)
│   ├── 1.2 Clavicle, Thoracic Cage & Dorsal Spine (Chest)
│   ├── 1.3 Lumbar & Pelvic Girdle (Hips)
│   ├── 1.4 Articulated Upper Limbs (Biceps, Forearm, Hand)
│   └── 1.5 Articulated Lower Limbs (Thigh, Calf, Ankle/Shoe)
├── 2.0 Garment Layering System
│   ├── 2.1 Base Undergarment (Collared Shirt / T-Shirt / Blouse)
│   ├── 2.2 Tailored Outerwear (Kapoteh Frock Coat, Trench, Blazer)
│   ├── 2.3 Lower Garments (Slacks, Jeans, Pleated Maxi Skirts)
│   └── 2.4 Footwear (Leather Oxford Shoes, Work Boots, Sandals)
├── 3.0 Cultural & Regional Markers (Jerusalem Archetypes)
│   ├── 3.1 Archetype A: Haredi Traditional
│   │   ├── Fedora / Wide-Brimmed Beaver Hat / Shtreimel Fur
│   │   ├── Double-Breasted Long Black Silk/Wool Frock Coat
│   │   ├── Flowing Payot (Sidecurls) & Full Beard
│   │   └── Tzitzit White Wool Tassels Hanging at Hip ($x4$)
│   ├── 3.2 Archetype B: Modern Mediterranean Resident
│   │   ├── Fitted Knit Polo / Linen Open-Collar Shirt
│   │   ├── Rolled-Cuff Chinos / Selvedge Denim
│   │   └── Cropped Textured Hair & Sunglasses
│   ├── 3.3 Archetype C: IDF Soldier on Leave
│   │   ├── Olive-Drab (Khadaki) Twill Uniform with Shoulder Epaulets
│   │   ├── Beret Tucked into Left Epaulet (Red, Brown, Green)
│   │   └── Heavy Tan Nubuck Infantry Boots (Vibram Soles)
│   └── 3.4 Archetype D: Old City Merchant
│       ├── Embroidered Velvet Vest over Crisp White Thobe
│       ├── Patterned Kaffiyeh Headcloth with Black Agal Cord
│       └── Woven Leather Slip-On Shoes
└── 4.0 Dynamic Accessories & Handheld Props
    ├── 4.1 Canvas Market Tote / Embroidered Leather Handbag
    ├── 4.2 Paper Shopping Bags with Twisted String Handles
    └── 4.3 Smartphone / Umbrellas
```

#### Detailed Specification: Haredi Resident Archetype ($1.78\text{ m}$ height)

| Bone / Segment | Part Name | Geometry Primitive | Sizing Parameters ($r, l$) / Local Offsets | PBR Shader Material & Texture |
| :--- | :--- | :--- | :--- | :--- |
| **Head** | Cranium | Tapered 8-sided Box | $w=0.18, d=0.20, h=0.22$, center $y=1.65$ | Warm Skin Tone: `#cbb19b`, Roughness: `0.65` |
| **Head** | Black Fedora Hat | Lathe Crown + Flanged Brim | Brim $r=0.28, t=0.012$; Crown $r=0.12, h=0.14$ | Black Brushed Felt: `#111112`, Roughness: `0.92` |
| **Head** | Facial Beard & Payot | Curved Tapered Ribbons | Beard $l=0.16$, Payot $l=0.24, r=0.015$ | Hair Pigment: Black `#0c0c0d` or Silver `#888` |
| **Torso** | Crisp White Shirt | Tapered Hex Prism | $[0.36, 0.48, 0.22]$, offset $y=1.22$ | Cotton Weave: `#f6f6f4`, Roughness: `0.7` |
| **Torso** | Frock Coat (Kapoteh) | Flared Split-Skirt Coat | Chest $w=0.42$, hem $w=0.58$, length to $y=0.72$ | Satin-Lined Wool: `#151518`, Rough: `0.65`, Specular sheen |
| **Pelvis** | Tzitzit Tassels (x4) | Thin Filament Tubes | $l=0.28, r=0.003$ at 4 pelvic corners | White Wool Knots: `#ededeb`, Rough: `0.9` |
| **Legs** | Tailored Slacks | Dual Cylinders (8-sided) | $r_{\text{hip}}=0.10, r_{\text{ankle}}=0.075, l=0.82$ | Deep Charcoal/Black Wool: `#161617`, Roughness: `0.8` |
| **Feet** | Oxford Shoes | Beveled Ergonomic Wedge | $[0.11, 0.08, 0.28]$, stacked heel $0.025$ | Polished Black Leather: `#0f0f10`, Roughness: `0.25` |

---

### 2.4 Mediterranean Urban Botany & Street Foliage

```
Botanical Asset
├── 1.0 Subterranean & Base Elements
│   ├── 1.1 Curbside Cast-Iron Tree Grate (Circular / Hexagonal Radial Slots)
│   ├── 1.2 Elevated Hexagonal Cut-Stone Tree Planter / Bench Surround
│   └── 1.3 Exposed Basal Flare Root Buttresses & Organic Soil Mound
├── 2.0 Trunk & Primary Branch Architecture
│   ├── 2.1 Fluted, Spiral-Gnarled Heartwood Core (Olive)
│   ├── 2.2 Vertical Columnar Central Leader (Cypress)
│   ├── 2.3 Secondary Sculptural Bifurcations & Forking Knees
│   └── 2.4 Weathered Bark Fissures & Deadwood Hollows (*Cavities*)
├── 3.0 Foliage Canopy & Sub-Branching
│   ├── 3.1 Densely Overlapping Shingled Frustums (Cypress Flame Silhouette)
│   ├── 3.2 Floating Cloud Pockets (Olive Micro-Clusters)
│   └── 3.3 Radiating Compound Pinnate Fronds (Date Palm Crown)
└── 4.0 Seasonal & Botanical Accessories
    ├── 4.1 Ripening Olives (Deep Purple-Black Drupes, $x30-50$)
    ├── 4.2 Clustered Date Stalks (Golden-Amber Hanging Fruit)
    └── 4.3 Lichen Crusts & Moss Patches on Windward Trunk Bark
```

#### Detailed Specification: Ancient Gnarled Jerusalem Olive Tree (*Olea europaea*)

| Sub-Assembly | Part Description | Procedural Generation Rule | Dimensions / Branching Rules | Material, Normals & PBR Spec |
| :--- | :--- | :--- | :--- | :--- |
| **Trunk Base** | Basal Root Flare | 5-point Lofted Star Polygon | Base $r=0.65\text{ m}$, tapering to $0.42\text{ m}$ at $y=1.1\text{ m}$ | Fissured Olive Bark: `#5a4a3a`, Deep normal crevice map |
| **Main Burl** | Gnarled Core Trunk | Twisted Lathe + Spiral Displacement | Twist: $180^\circ$ over $1.8\text{ m}$, radial noise amplitude $0.12\text{ m}$ | Roughness: `0.95`, Ambient Occlusion cavity darkening |
| **Scaffold Limbs** | 3 Primary Forks | Directional Branch Splitting | Angles: $45^\circ, 135^\circ, 260^\circ$ azimuth, tilt $35^\circ-50^\circ$ | Radius $r_1=0.22\text{ m} \rightarrow r_2=0.12\text{ m}$, length $1.6\text{ m}$ |
| **Foliage Pods** | 7 Distributed Leaf Clouds | Dual-Lobe Deformed Icosahedra | Radii $0.85\text{ m}-1.35\text{ m}$, subdivided $1\times$, jittered vertices | Bi-Color Leaf Shader: Top `#5c684d`, Underside `#98a38c` |
| **Translucency** | Foliage Subsurface | Subsurface Scattering Fake | Inverted Normal Dot Product $\max(0, -L \cdot V)$ | Leaf Sheen: Roughness `0.45`, SSS Emissive: `#6c7a52` |

#### Detailed Specification: Columnar Italian Cypress (*Cupressus sempervirens*)
* **Geometry:** Central spire leader trunk ($r=0.14\text{ m}$ at base, height $9.5\text{ m}$).
* **Canopy Profile:** 9 tiered overlapping inverted cones with serrated multi-pointed star cross-sections (10 points per ring). Each tier offsets and twists by $18^\circ$ relative to the lower tier, generating a dense, non-repetitive flame silhouette.
* **Coloration:** Deep forest evergreen (`#1a2e1b`), with windward tips highlighted in yellow-green sage (`#2d4528`).

---

### 2.5 Architectural Facades, Storefronts & Rooftop Infrastructure

```
Storefront & Rooftop Assembly
├── 1.0 Ground-Floor Retail Portal
│   ├── 1.1 Heavy Jerusalem Limestone Architrave & Pilasters
│   ├── 1.2 Deep Recessed Doorway Threshold (0.45 m Step-Back)
│   ├── 1.3 Extruded Dark Bronze / Steel Window Mullions
│   └── 1.4 Clear Float-Glass Display Windows with Interior Depth Box
├── 2.0 Security & Shading Hardware
│   ├── 2.1 Galvanized Steel Perforated Roll-Up Shutter Housing
│   ├── 2.2 Segmented Articulated Slats in Wall Guide Channels
│   ├── 2.3 Cantilevered Fabric Folding-Arm Awning (Tri-Fold Mechanism)
│   └── 2.4 Deep Valance with Scalloped / Castellated Edge & Fringe
├── 3.0 Signage & Identity Modules
│   ├── 3.1 Translucent Acrylic Fascia Signbox with Internal LED
│   ├── 3.2 Laser-Cut Powder-Coated Metal Dimensional Lettering
│   └── 3.3 Cantilevered Wrought-Iron Projecting Blade Sign (Round/Ornate)
└── 4.0 Rooftop Infrastructure (Dud Shemesh & HVAC)
    ├── 4.1 Solar Water Heater Tank (Cylinder with Welded Seams & Fittings)
    ├── 4.2 Solar Collector Panel (Glass Top, Absorber Ribs, Galvanized Legs)
    ├── 4.3 Copper Connecting Pipes with Thermal Insulation Foam
    └── 4.4 Dual-Fan Commercial AC Compressor (Stamped Louver Grilles & Fan Blades)
```

#### Detailed Specification: Israeli Rooftop Solar Water Heater (*Dud Shemesh*)

| Component | Part Description | Geometry Specification | Relative Offset $[x, y, z]$ | PBR Finish & Wear |
| :--- | :--- | :--- | :--- | :--- |
| **Storage Tank** | 150L Insulated Boiler | Cylinder (10 sides), $r=0.28, l=1.65$, horizontal | Offset $[0.0, 1.25, -0.65]$, axis aligned along $X$ | Baked White Enamel: `#e8e6e1`, Rust Streaks at fittings |
| **Tank Bracket** | Steel Saddle Cradle | Twin curved strap channels $[0.05, 0.35, 0.65]$ | Strapped under tank at $x = \pm 0.55$ | Galvanized Angle Iron: `#7d828a`, Metal: `0.85` |
| **Collector Panel** | Black Absorber Plate | Slanted Box $[1.15, 0.09, 1.85]$, tilt $42^\circ$ | Angled south ($+Z$), front lip at $y=0.35$ | Solar Glazing: `#0e141c`, Mirror Specular, Copper header |
| **Collector Frame**| Structural Tripod | Triangular truss tubes ($r=0.018$) | Legs anchoring to rooftop slab pads | Rust-Inhibited Steel Primer: `#803828`, Metal: `0.6` |
| **Plumbing** | Inlet / Return Loops | Segmented Spline Pipe ($r=0.014$) | Connecting bottom of panel to tank center | Armaflex Black Foam Insulation `#222` + Brass Valves |

#### Detailed Specification: High-Rise Dual-Fan HVAC Compressor Unit ($1.45\text{ m} \times 1.15\text{ m} \times 0.65\text{ m}$)
* **Cabinet:** Powder-coated beige-gray sheet metal casing (`#d2d0c8`, roughness `0.55`, metallic `0.3`) with recessed stamped intake louvers on three sides.
* **Discharge Grilles (x2):** Circular recessed intake cones ($r=0.38\text{ m}$) with concentric wire finger-guards and internal 4-blade axial fan propellers.
* **Service Valves & Conduit:** High/low pressure brass service ports, braided flexible metal electrical conduit entering through a weatherproof gland.
* **Mounting:** Elevated on twin extruded EPDM vibration-isolation rubber foot rails ($0.12\text{ m}$ height) to prevent acoustic roof transmission.

---

## 3. Unified Performance, Batching & Memory Strategy

To guarantee that the introduction of multi-part procedural assets does not compromise 60 FPS performance or violate the **450 draw-call budget**, the engine employs two distinct rendering paradigms:

```
                      Procedural Asset Pipeline
                                  │
         ┌────────────────────────┴────────────────────────┐
         ▼                                                 ▼
[Dynamic / Moving Entities]                       [Static / Chunk Entities]
• Vehicles (Cars, Vans, Trams)                    • Storefronts & Building Facades
• Pedestrians (Crowd Mannequins)                  • Street Furniture & Trees
• Rooftop Props (Duds, ACs)                       • Market Stalls & Souks
         │                                                 │
   Compound Baked                                    Modular Palette
  InstancedMeshes                                     Instanced Kits
(1 Draw Call per Type)                             (10 Draw Calls Shared City-Wide)
```

---

### 3.1 Paradigm A: Compound Baked `InstancedMesh` (Vehicles & Pedestrians)

For mobile and high-density props (Cars, Delivery Vans, Tram Modules, Pedestrians, Solar Heaters), all hierarchical sub-components are **pre-merged at boot/initialization** into a single non-indexed `BufferGeometry`.

#### Vertex Buffer Layout:
Each vertex contains:
1. `position` (`Float32Array`, 3 floats, 12 bytes)
2. `normal` (`Float32Array`, 3 floats, 12 bytes)
3. `aPart` (`Float32Array`, 1 float, 4 bytes): ID identifying the sub-component (e.g., $0=\text{Chassis}$, $1=\text{Wheel}$, $2=\text{Glass}$, $3=\text{LightLens}$, $4=\text{Interior}$).
4. `aCustomPBR` (`Float32Array`, 4 floats, 16 bytes):
   * $X$: Sub-part roughness override ($0.0 - 1.0$)
   * $Y$: Sub-part metalness override ($0.0 - 1.0$)
   * $Z$: Light/Emission flag ($0.0=\text{None}$, $1.0=\text{Headlight}$, $2.0=\text{Taillight}$, $3.0=\text{InteriorWindow}$, $4.0=\text{FoliageSSS}$)
   * $W$: Baked Ambient Occlusion factor ($0.2=\text{Deep Crevice} \rightarrow 1.0=\text{Exposed}$)
5. `color` (`Float32Array`, 3 floats, 12 bytes): Base albedo tint of the sub-part.

#### Instance Attributes (Per Actor):
1. `instanceMatrix` (`Matrix4`, 16 floats, 64 bytes): Position, yaw/pitch/roll, scale.
2. `instanceColor` (`Vector3`, 3 floats, 12 bytes): Primary body color (applied via shader multiplication to marked chassis parts).
3. `aAnimState` (`Vector4`, 4 floats, 16 bytes, optional for crowd): Stride phase, gait rate, lean angle, blink state.

#### Shader Execution Pipeline:
```glsl
// Standard Material Injection Hook
#include <roughnessmap_fragment>
roughnessFactor = (aCustomPBR.x > 0.0) ? aCustomPBR.x : roughnessFactor;

#include <metalnessmap_fragment>
metalnessFactor = (aCustomPBR.y > 0.0) ? aCustomPBR.y : metalnessFactor;

#include <emissivemap_fragment>
if (aCustomPBR.z > 0.5 && aCustomPBR.z < 1.5) {
    // Headlight Lens: warm white glow, hyper-intense at night
    totalEmissiveRadiance += vec3(1.0, 0.95, 0.88) * (0.4 + 18.0 * uNight);
} else if (aCustomPBR.z > 1.5 && aCustomPBR.z < 2.5) {
    // Taillight: ruby red glow + brake light intensification
    totalEmissiveRadiance += vec3(1.0, 0.04, 0.02) * (0.3 + 6.0 * uNight);
}

#include <color_fragment>
// Multiply instanceColor only onto primary exterior body panels
if (aPart == 0.0) {
    diffuseColor.rgb *= vInstanceColor.rgb;
}
// Apply baked vertex ambient occlusion
diffuseColor.rgb *= aCustomPBR.w;
```

---

### 3.2 Paradigm B: Shared Modular Palette Kits (Market Stalls & Storefronts)

For irregular, sprawling assemblies like the Mahane Yehuda market and Old City souks, merging every unique stall into chunk meshes would inflate streaming memory and defeat instancing. Instead, the engine implements the **Shared Palette Kit**:

* **Component Part Registry:**
  A single global registry instantiates exactly **12 master `InstancedMesh` objects** at the scene root:
  1. `Mesh_StallCrate`
  2. `Mesh_ProduceMound`
  3. `Mesh_SpiceBowl`
  4. `Mesh_SpiceCone`
  5. `Mesh_BurlapSack`
  6. `Mesh_DisplayRiser`
  7. `Mesh_TimberPole`
  8. `Mesh_PriceCard`
  9. `Mesh_AwningFabric`
  10. `Mesh_GlassDisplay`
  11. `Mesh_HangingTextile`
  12. `Mesh_LampBulb`

* **Procedural Placement:**
  When a chunk loads, worker threads evaluate the footprint of market zones and generate transform matrices $[x, y, z, \text{yaw}, s_x, s_y, s_z]$ and color hexes for sub-parts. Instead of creating chunk-specific meshes, the worker appends instance data to the global palette arrays.
* **Draw-Call Impact:**
  Whether there are **10 stalls or 2,500 stalls** across Jerusalem, the entire market system consumes **precisely 12 draw calls** in the main camera pass.

---

### 3.3 Polygon Budgets & Level-of-Detail (LOD) Strategy

| Asset Category | LOD0 (Near: $0-60\text{ m}$) | LOD1 (Mid: $60-180\text{ m}$) | LOD2 (Far: $>180\text{ m}$) | Strategy |
| :--- | :--- | :--- | :--- | :--- |
| **Sedan / Hatchback** | $1,280$ tris | $340$ tris | $48$ tris (bounding envelope) | Swapped via chunk distance or CPU population index |
| **Delivery Van** | $1,120$ tris | $290$ tris | $38$ tris | Unified merged buffer with index range selection |
| **Light Rail Tram (5 Cars)**| $6,800$ tris | $1,850$ tris | $220$ tris | Articulated collision stays constant |
| **Pedestrian Mannequin**| $620$ tris | $180$ tris | Billboards / Culled ($>80\text{ m}$) | Frustum & distance radius cutoff ($80\text{ m}$) |
| **Ancient Olive Tree** | $2,100$ tris | $640$ tris | $96$ tris (impostor cross) | Chunk LOD streaming (`near` vs. `medium`) |
| **Columnar Cypress** | $940$ tris | $220$ tris | $32$ tris | Chunk LOD streaming |
| **Produce Market Stall** | $1,850$ tris | $450$ tris | Culled ($>120\text{ m}$) | Sub-part exclusion in worker placement |
| **Rooftop Solar Unit** | $380$ tris | $84$ tris | Culled ($>250\text{ m}$) | Assigned `detail: true` (omitted from Mid/Far chunks) |

---

### 3.4 Exhaustive Scene Draw-Call Budget & Accounting

To guarantee the engine never exceeds the **450 draw-call threshold**, the following budget is strictly allocated across rendering subsystems under maximum load (camera at Jaffa Road overlooking Old City, with all dynamic systems running):

| Subsystem | Max Concurrent Objects / Batches | Draw Calls (Main Pass) | Draw Calls (Shadow Pass) | Subtotal Draw Calls | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Terrain Mesh** | 1 near high-res + 1 outer skirt | $2$ | $1$ | **$3$** | Merged continuous heightmap |
| **City Buildings** | 24 active streaming chunks | $24$ | $12$ | **$36$** | 1 merged mesh per chunk |
| **Roads & Infrastructure**| Asphalt ($24$), Paving ($24$), Curbs ($18$), Markings ($12$) | $78$ | $0$ (Shadows off) | **$78$** | Layered polygon offsets |
| **Rooftop Props** | Solar ($18$ chunks), AC ($18$ chunks) | $36$ | $18$ | **$54$** | `InstancedMesh` per active near chunk |
| **Street Furniture** | Lamps ($18$), Benches ($18$), Bollards ($12$) | $48$ | $18$ | **$66$** | Shared chunk instances |
| **Urban Botany** | Cypresses ($18$), Olives ($18$) | $36$ | $18$ | **$54$** | Shared props material |
| **Market Souk System** | Global 12-part palette kit | $12$ | $6$ | **$18$** | City-wide shared instances |
| **Traffic System** | Cars, Vans, Tram, Rails, Headlight Cones | $5$ | $3$ | **$8$** | Global dynamic vehicle pools |
| **Pedestrian Population**| Mannequins (1) + Rigged GLTFs (4) | $5$ | $2$ | **$7$** | Dynamic instanced crowd |
| **Landmark Structures** | Walls, Gates, Dome of Rock, Chords Bridge | $28$ | $14$ | **$42$** | Bespoke landmark geometry |
| **Lighting & VFX** | Dust motes, light pools, sky, sun glints | $6$ | $0$ | **$6$** | Unlit / additive passes |
| **Post-Processing** | FXAA, Bloom extract, Blur, Tone mapping | $5$ | $0$ | **$5$** | Fullscreen quad passes |
| **RESERVE HEADROOM** | Dynamic UI, teleport markers, debug gizmos | $25$ | $0$ | **$25$** | Safety margin |
| **TOTAL PEAK CALLS** | — | **$309$** | **$91$** | **$402$** | **Well under 450 limit!** |

---

## 4. Implementation Blueprint & Phase-by-Phase Roadmap

### Phase 1: Vehicles & Transit High-Fidelity Overhaul
1. **Geometry Generator Refactor:**
   * Rewrite `carGeometry()`, `vanGeometry()`, and `tramModuleGeometry()` in `src/city/TrafficSystem.js`.
   * Implement wheel well arches, recessed radiator grilles, chamfered greenhouses, side mirrors, and segmented tire/alloy wheel assemblies.
2. **Material Attribute Upgrade:**
   * Extend `vehicleMaterial()` to read `aCustomPBR` attributes for specular clearcoat, matte rubber, machined chrome, and intense night emissive bloom.
3. **Validation:**
   * Verify test suite (`npm test`) passes with updated vertex formats.
   * Inspect visual fidelity and verify traffic draw calls remain $\le 8$.

### Phase 2: Market Stalls & Souk Architecture Expansion
1. **Palette Kit Expansion:**
   * Refactor `src/city/landmarks/stalls.js` from basic cones and boxes to rich compound primitives (mounded produce with fruit texture normals, brass-embossed spice bowls, folded burlap sacks with rolled cuffs, and scalloped cloth awnings).
2. **Material Tuning:**
   * Inject subsurface scattering approximations for fruits and spices into `createGoodsMaterial()`.
3. **Validation:**
   * Teleport to Mahane Yehuda Market (`/teleport market`) and verify framerate maintains $60\text{ FPS}$ with zero hitching.

### Phase 3: Pedestrian Anatomical & Cultural Diversity
1. **Mannequin Mesh Rebuilding:**
   * Overhaul `createPedestrianMesh()` in `src/city/PedestrianSystem.js`.
   * Add cultural wardrobe presets (Haredi Kapoteh frock coat with hanging Tzitzit, modern casual linen, IDF uniform epaulets).
2. **Animation Shader Refinement:**
   * Enhance `pedSwing` vertex shader with subtle torso counter-twist and head bobbing synchronized to step cadence.
3. **Validation:**
   * Confirm shadows dynamically reflect apparel changes via `mesh.customDepthMaterial`.

### Phase 4: Botanical & Architectural Ground Dressings
1. **Vegetation Upgrade:**
   * Upgrade `cypressGeometry()` and `oliveGeometry()` in `src/city/StreetProps.js` with fluted trunks, gnarled heartwood crevices, and dual-tone leaves.
2. **Storefront Geometric Portals:**
   * Enhance `Awnings.js` and `CityGenerator.js` with physical recessed shop doorways, roll-up shutter hoods, and projecting wrought-iron blade signage.
3. **Rooftop Detail Polish:**
   * Upgrade `solarHeaterGeometry()` with welded seam details, copper pipe loops, and dual-fan HVAC compressor units.

---

## 5. Architectural Acceptance Checklist

Before merging future implementation pull requests against this blueprint, the code reviewer must verify:
* [ ] **Draw-Call Audit:** Total draw calls measured in `BenchmarkHUD` do not exceed $450$ under any camera orientation or zoom level.
* [ ] **Geometry Memory:** Total GPU memory allocated for geometries in a standard 9-chunk active streaming radius does not exceed $95\text{ MB}$.
* [ ] **Zero Unbatched Primitives:** No new `THREE.Mesh` instances are created in loops; all recurring props use `InstancedMesh` or chunk-merged geometry.
* [ ] **Automated Test Integrity:** All Node test suites (`npm test`) continue to achieve 100% pass rates with zero regression in collision detection or world bounds.
* [ ] **Night Cycle Fidelity:** Every newly introduced asset correctly hooks into the `uNight` uniform, transitioning smoothly between daylight specular response and nocturnal emissive radiance.

---
*Signed and Approved for Architectural Implementation,*  
**Lead Technical Art & Code Architect** — `procedural-city` Core Team
