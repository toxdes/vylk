# vylk documentation

These files are the only source of the vylk documentation. The [website](https://vylk.app/docs/) renders them from each release tag.

| Page | Type | Reader |
| --- | --- | --- |
| [getting-started.md](getting-started.md) | Tutorial | Anyone. No programming knowledge assumed. |
| [how-to.md](how-to.md) | How-to guides | Anyone. No programming knowledge assumed. |
| [concepts.md](concepts.md) | Explanation | Anyone. No programming knowledge assumed. |
| [encryption.md](encryption.md) | Explanation | Technical readers. Linked from the app's **Learn More** links. |
| [cli-reference.md](cli-reference.md) | Reference | Technical readers. |
| [api/README.md](api/README.md) | Reference | Client developers. |
| [development.md](development.md) | How-to guides | Contributors. Not published on the website. |

## Rules

- Update these pages in the same change as the behavior they describe.
- Name UI elements with their exact labels, in bold.
- Link between pages with relative `.md` links. The website converts them.
- Write `__VYLK_VERSION__` where a release version belongs. The website replaces it.
- Use only headings, paragraphs, flat lists, tables, fenced code, bold, inline code, and links. The website build fails on other Markdown.
- Keep the `encryption.md` file name. The app links to `/docs/encryption.html`.
