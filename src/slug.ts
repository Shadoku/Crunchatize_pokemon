// The single definition of how a species name becomes a portrait filename.
// Lives on its own so the build plugin (scripts/vite-plugin-portraits.ts) can
// share it with the app without pulling in the lorebook: the two must agree
// exactly, or a portrait is emitted under a name the panel never asks for.
//
// e.g. "Nidoran♀" -> "nidoranf", "Mr. Mime" -> "mrmime", "Exeggcute" ->
// "exeggcute".
export function slugifySpecies(name: string): string {
    return name
        .toLowerCase()
        .replace(/♀/g, 'f')
        .replace(/♂/g, 'm')
        .replace(/[^a-z0-9]/g, '');
}
