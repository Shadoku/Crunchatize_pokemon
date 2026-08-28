// Packs the card and the lorebook into one importable file.
//
// The three pieces are edited separately - the card is prose, the lorebook is
// data, and keeping them apart is what makes either of them maintainable. But
// asking someone to import two files and remember to attach the second one is
// two chances to end up with a card set in Takane and no idea what Takane is.
// So: edit the sources, run this, hand out the bundle.
//
//   yarn bundle-card
//
// Output carries the lorebook as the v2 spec's `character_book`, which chub
// and SillyTavern both read on import. The standalone lorebook file is still
// the one to import if you want it available to other cards too.

import {readFile, writeFile, mkdir} from 'fs/promises';

const CARD = 'distributables/moemon-adventure-rpg.json';
const LOREBOOK = 'distributables/moemon-lore.json';
const OUT_DIR = 'dist-cards';
const OUT = `${OUT_DIR}/moemon-adventure-rpg-with-lorebook.json`;

const card = JSON.parse(await readFile(CARD, 'utf8'));
const book = JSON.parse(await readFile(LOREBOOK, 'utf8'));

// The lorebook file keys its entries by index (the chub/SillyTavern export
// shape); character_book wants a plain array, in insertion order.
const entries = Object.keys(book.entries)
    .sort((left, right) => Number(left) - Number(right))
    .map(key => book.entries[key])
    .map(entry => ({
        keys: entry.key,
        secondary_keys: entry.keysecondary,
        comment: entry.comment || entry.name,
        content: entry.content,
        constant: entry.constant,
        selective: entry.selective,
        insertion_order: entry.insertion_order,
        enabled: entry.enabled,
        position: 'before_char',
        case_sensitive: entry.case_sensitive,
        name: entry.name,
        priority: entry.priority,
        id: entry.id,
        extensions: entry.extensions
    }));

card.data.character_book = {
    name: book.name,
    description: book.description,
    scan_depth: book.scan_depth,
    token_budget: book.token_budget,
    recursive_scanning: book.recursive_scanning,
    extensions: {},
    entries
};

await mkdir(OUT_DIR, {recursive: true});
await writeFile(OUT, JSON.stringify(card, null, 2) + '\n');

console.log(`\x1b[32m✓\x1b[0m bundle-card: ${entries.length} lorebook entries → ${OUT}`);
