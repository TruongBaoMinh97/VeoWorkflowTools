# MASTER PROMPT — ETSY FASHION AI IMAGE ENGINE v2.1
# Static/Dynamic Split Architecture

## Architecture Overview

The prompt is split into **STATIC** (same for every product) and **DYNAMIC** (AI-analyzed per product) sections to minimize token usage and maximize consistency.

```
STATIC TEMPLATE (pre-written)     +     DYNAMIC (AI analyzes)
────────────────────────────       ─────────────────────────
reference  ✅ fixed                garment      🔄 per product
model      ✅ fixed                background   🔄 per product
pose       ✅ fixed                negative     🔄 per product
composition ✅ fixed
lighting   ✅ fixed
branding   ✅ fixed
final      ✅ fixed
```

**Token savings: ~75%** (from ~6,000 to ~1,500 total tokens)

---

## STATIC SECTIONS (copy as-is into every prompt)

### reference
```
Use the garment reference image as the absolute source of truth for all
clothing details. A separate adult model reference is supplied directly
to Flow — you do not see it and must not request it.
```

### model
```
Use the adult model appearance from the separately supplied model
reference. Do not name, identify, or invent their facial features, hair
color, or body measurements. Use natural adult proportions for full-body
composition.
```

### pose
```
Elegant three-quarter standing pose, one leg slightly forward, natural
S-curve silhouette, one hand resting near waist or relaxed at side.
Pose must not hide any important garment details. Full front or modest
three-quarter view.
```

### composition
```
One continuous photograph, one adult model wearing the actual product.
True full-body framing: top of head to bottom of both feet fully
visible. Leave breathing room below feet. Tall vertical portrait
format. No collage, grid, or multiple views.
```

### lighting
```
Photorealistic premium fashion photography. Natural skin tones,
realistic anatomy and body proportions, realistic fabric rendering and
drape, natural shadows, soft professional editorial lighting. Accurate
product color reproduction.
```

### branding
```
No text, logo, or watermark.
```

### final
```
Preserve all visible product details exactly as shown in the garment
reference. Use the separately supplied model appearance. Produce one
clean premium fashion catalog photograph.
```

---

## DYNAMIC SECTIONS (AI must analyze and write)

### garment (AI analyzes the product image)

AI must describe these visible attributes:
- **Color** — exact shade (navy, not "blue"; burgundy, not "red")
- **Fabric/texture** — satin, lace, mesh, velvet, chiffon, cotton, sequins...
- **Neckline** — V-neck, sweetheart, off-shoulder, scoop, square, halter...
- **Straps/sleeves** — spaghetti, strapless, cap sleeve, long sleeve, one-shoulder...
- **Bodice** — fitted, draped, ruched, corset, structured, relaxed...
- **Waist/hip** — empire, natural waist, drop waist, cinched, relaxed...
- **Silhouette** — bodycon, A-line, fit-and-flare, mermaid, shift, empire...
- **Skirt** — straight, flared, tiered, pleated, gathered, tulip...
- **Length** — mini, short, knee-length, midi, tea-length, maxi, floor-length
- **Decorative details** — ruching, pleats, ruffles, sequins, beading, bows, lace overlay, embroidery, mesh panels...
- **Special features** — slit, train, cut-out, visible zipper, corset lacing, pockets...

**CRITICAL RULES:**
1. Describe ONLY what is VISIBLE
2. Never invent details
3. Length must be EXACT (mini=mini, maxi=maxi)
4. Color must be exact shade
5. End with: "Preserve the exact original garment."

### background (AI picks based on garment type)

| Garment Type | Background |
|:---|:---|
| Formal/evening | Luxury ballroom, elegant hotel, refined European venue |
| Party/cocktail | Sophisticated rooftop, upscale restaurant, evening event |
| Casual | Stylish café, premium city setting, luxury hotel exterior |
| Loungewear/kimono | Luxury hotel suite, elegant dressing room, resort |
| Summer/resort | Mediterranean terrace, resort pool, elegant garden |
| Sleepwear | Plain ivory/cream studio (override lifestyle default) |

Always add: "Soft depth of field keeping garment as focal point. Background must not alter garment color."

### negative (AI adds product-specific items)

Standard negatives (always include):
```
No mannequin, no hanger, no garment redesign, no changed color or
fabric, no changed silhouette, no altered neckline or sleeves, no
invented details or embellishments, no extra clothes or accessories,
no distorted anatomy or unnatural hands, no cropped feet or legs or
hemline, no text or logo or watermark, no intimate or suggestive pose.
```

Product-specific negatives (AI adds based on analysis):
- Mini dress → "Do not lengthen — this is a mini dress"
- No train → "Do not add train or trailing fabric"
- Mesh/transparent → "Do not make mesh/transparent fabric opaque"
- No pockets → "Do not add pockets"
- Strapless → "Do not add straps"
- No slit → "Do not add slit"
- Simple back → "Do not invent decorative back design"

---

## GARMENT ANALYSIS RULES (System Prompt)

These rules govern how the AI analyzes the garment image:

1. **VISIBLE ONLY** — Describe only what is clearly visible
2. **COLOR PRECISION** — navy≠blue, burgundy≠red, ivory≠white, champagne≠beige
3. **LENGTH = EXTREME PRIORITY** — Never change length
4. **SILHOUETTE** — bodycon=bodycon, A-line=A-line, never transform
5. **FABRIC** — satin=satin, lace=lace, never swap. Never make transparent↔opaque
6. **NO-INVENTION** — No inventing pockets, zippers, trains, back details, etc.
7. **NO EXTRA GARMENTS** — No adding pants/shorts/leggings unless shown
8. **BACK VIEW** — If back shown, model faces away. If back not visible, don't describe
9. **SLEEPWEAR** — Neutral catalog. No suggestive. Plain studio background

---

## OUTPUT FORMAT

ETSY FLOW v1 JSON:
```json
{
  "kind": "garment",
  "chart": null,
  "status": "ready",
  "issues": [],
  "references": [{"index": 0, "role": "garment"}],
  "sections": {
    "reference": "STATIC — copy as-is",
    "model": "STATIC — copy as-is",
    "garment": "DYNAMIC — AI writes",
    "pose": "STATIC — copy as-is",
    "composition": "STATIC — copy as-is",
    "background": "DYNAMIC — AI writes",
    "lighting": "STATIC — copy as-is",
    "branding": "STATIC — copy as-is",
    "negative": "DYNAMIC — AI writes (standard + specific)",
    "final": "STATIC — copy as-is"
  }
}
```

Size chart detection:
```json
{
  "kind": "chart",
  "chart": null,
  "status": "needs_review",
  "issues": ["Size chart detected. Requires size chart workflow."],
  "references": [{"index": 0, "role": "garment"}],
  "sections": {}
}
```

---

## SPECIAL CASES

### Sleepwear / Lingerie
- Override background → plain ivory/cream studio
- Override pose → natural upright, front/three-quarter, calm expression
- No suggestive poses, no bed, no boudoir
- Keep exact design — do not add coverage or change transparency
- If non-explicit catalog presentation impossible → needs_review

### Back View
- Model faces AWAY from camera
- Do NOT rotate to front
- Preserve visible back construction only
- Do NOT invent front details from back view

### Separate Model and Garment References
- MODEL supplies visible adult appearance only
- GARMENT supplies the target product
- Different people/outfits are expected and normal
- Do NOT return needs_review for cropped MODEL, different outfit, or missing full-body
