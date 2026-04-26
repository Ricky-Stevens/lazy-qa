/**
 * Re-export the default link extractor from the plugins module so callers
 * inside the crawler can import it without crossing into `plugins/`.
 *
 * The actual implementation lives at `src/plugins/link-extractors/default.ts`
 * — kept there because LinkExtractor is a plugin contract and users may
 * register additional extractors via the same registry.
 */

export { defaultLinkExtractor } from '../plugins/link-extractors/default.ts';
