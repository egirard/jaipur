# Original component artwork

All component illustrations in `static/components/` were generated specifically
for this GPLv3 implementation with OpenAI's built-in image-generation tool on
2026-07-30. They do not reuse the published Jaipur logo, illustrations,
ornamental frames, card layouts, or trade dress.

The shared art direction was:

> Refined hand-painted gouache and block-print texture; a crisp, centred
> editorial board-game illustration; warm late-afternoon bazaar light; visible
> paper grain and dry-brush edges; no people, text, numerals, logos, watermark,
> border, copied artwork, or copied trade dress.

The individual subjects were:

| File | Generated subject | Used for |
| --- | --- | --- |
| `diamond.webp` | Three diamonds on dark teal velvet | Diamond cards and tokens |
| `gold.webp` | Gold ingots on a merchant scale | Gold cards and tokens |
| `silver.webp` | Silver ingots and a chased-metal cup | Silver cards and tokens |
| `cloth.webp` | Tied bolts of patterned cloth | Cloth cards and tokens |
| `spice.webp` | Saffron, cardamom, cinnamon, and star anise | Spice cards and tokens |
| `leather.webp` | Rolled vegetable-tanned hides and an embossing tool | Leather cards and tokens |
| `camel.webp` | A single decorated dromedary | Camel cards, herd, and camel scoring |
| `seal.webp` | An original radiant merchant medallion | Seals of Excellence |
| `card-back.webp` | An original symmetrical bazaar-canopy pattern | Deck, hidden hands, and bonus tokens |

The generated 1536-pixel PNG sources were reviewed and converted to
512-by-512 WebP assets at quality 84 for the web client. Accessible names,
values, state, and rules remain HTML text; artwork is never the sole carrier of
meaning.

# Background music

`static/audio/marketplace-melody.mp3` ("Marketplace Melody remix v1 ext
v1.1") was authored by the project owner with Udio on 2026-09-16 and is
used as the tabletop's looping background music (muted with the speaker
button in each player's corner or in Table options; the choice is
remembered in the browser).

# Sound effects

`static/audio/sfx/` holds five recordings authored by the project owner on
2026-09-16 (camel-herd — re-recorded louder the same day, pickup-goods-1/2,
selling-goods, coins-landing).
The table plays short randomised excerpts of them (volume, playback rate,
start offset and length vary per play; see `src/lib/sfx.ts`) when camels are
taken, a good is taken or traded, a sale starts, and tokens land. They
follow the music mute button and volume slider.
