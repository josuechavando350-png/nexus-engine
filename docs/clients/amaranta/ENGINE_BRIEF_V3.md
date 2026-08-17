# Amaranta — NEXUS Experience brief V3

This pass extends the approved Amaranta V2 experience. NEXUS remains the visual-direction authority; implementation may only wire content, assets, timing and interaction states described here.

## Preserve

- Existing black / white editorial composition and hierarchy.
- Natural-color food, room, chef and experience photography.
- Color Google map.
- Real WhatsApp brand glyph and number `729 242 7952` / `+527292427952`.
- Experience carousel with all supplied photographs and no empty media slots.
- Compact review rail and breakfast menu placement.
- Strict rejection of decorative `01 / 02 / 03` section numbering.

## Splash / preloader

Before the page is revealed, show a full viewport `#000` screen with this reading order:

1. `AMARANTA`
2. `Cocina mexicana`
3. A thin horizontal line that draws itself underneath.
4. Brand-specific line: `El Estado de México, servido con memoria y futuro.`

The complete transition from splash to visible page must remain inside the user's requested 0.8–1.9 second window. Use restrained motion only: line draw, then opacity fade. No gradients, particles, loaders, percentages, logos spinning, numbered sequences or decorative counters.

## Touch micro-interaction — breakfast and reviews

Every breakfast entry and every compact review item must be individually touchable/focusable. Touch, keyboard focus and pointer hover must create the same premium emphasis state:

- very small elevation / scale shift;
- brighter fine border;
- restrained neutral luminous halo around the item;
- text contrast may rise slightly;
- no new brand color and no generic gradient surface;
- the selected/touched state may persist until another item is activated.

The effect must not move surrounding layout, must not hide text and must respect `prefers-reduced-motion`.

## Rejection conditions

Reject and regenerate if any of the following appears:

- splash exceeds 1.9 seconds or is shorter than 0.8 seconds;
- splash uses a non-black base, a spinner, percentage counter, numbered sequence or generic gradient;
- breakfast or review entries have no touch/focus state;
- interaction creates clipping, layout shift or unreadable text;
- any supplied experience photo becomes an empty placeholder;
- map becomes grayscale;
- WhatsApp loses the recognizable WhatsApp glyph or uses the old number.
