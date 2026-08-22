# Image Generation

Use `generate_image` only when the user asks for a new raster image such as a photo, illustration,
banner, background, product mockup, sprite, or infographic.

Do not use it for SVG assets, simple diagrams that should be code, an existing vector system, or an
edit to an existing image. Never generate an image merely to decorate an answer.

## Prompt workflow

1. Preserve a detailed user prompt without inventing new characters, objects, brands, slogans, or
   story elements.
2. For a generic request, add only details that materially improve the requested result.
3. Structure the prompt in this order: purpose, scene, subject, composition, visual style, lighting,
   exact text, constraints.
4. Put exact in-image text in straight quotes and require verbatim rendering with no extra text.
5. State important exclusions explicitly, including no watermark, no logo, or no additional objects
   when applicable.
6. Use `size=auto`, `quality=auto`, and `background=auto` unless the user or intended layout requires
   an explicit value.
7. Use one `generate_image` call for one requested final. For variants, make one call per variant.

The tool saves a non-overwriting WebP in the authorized workspace and sends it to the current
Telegram chat. Report the returned path after successful delivery.

If the tool reports an unknown status, stop. Do not call it again automatically because the Codex
subscription limit may already have been charged.
