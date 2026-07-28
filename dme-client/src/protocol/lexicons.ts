/**
 * Re-export the Lexicon JSON for runtime validation.
 * The atproto SDK consumes this format directly.
 */

import envelopeLexicon from './lexicons/dme.queue.envelope.json';
import backupLexicon from './lexicons/dme.backup.identity.json';

export const lexicons = {
  [envelopeLexicon.id]: envelopeLexicon,
  [backupLexicon.id]: backupLexicon,
};

export const DME_LEXICONS = [envelopeLexicon, backupLexicon];
