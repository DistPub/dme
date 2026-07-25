/**
 * Re-export the Lexicon JSON for runtime validation.
 * The atproto SDK consumes this format directly.
 */

import envelopeLexicon from './lexicons/dme.queue.envelope.json';

export const lexicons = {
  [envelopeLexicon.id]: envelopeLexicon,
};

export const DME_LEXICONS = [envelopeLexicon];
