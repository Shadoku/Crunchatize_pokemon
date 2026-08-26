import type {Plugin, ViteDevServer} from 'vite';
import {promises as fs} from 'fs';
import path from 'path';
import {slugifySpecies} from '../src/slug';

// Portrait masters live in public/moemon/ at whatever size they were drawn -
// often a megabyte or more each. Shipping those inside the stage bundle would
// make the deploy zip enormous, so the build re-encodes them to WebP at a
// sane size and the originals never reach dist/.
const SOURCE_DIR = path.resolve('public/moemon');
const DIST_DIR = path.resolve('dist/moemon');
const URL_PREFIX = '/moemon/';

// Long edge, in pixels. Portraits render at ~38px as a roster thumbnail and
// are capped by the panel in the full view, so this is generous.
const MAX_EDGE = 768;
const WEBP_QUALITY = 80;

const SOURCE_PATTERN = /\.(png|jpe?g|webp)$/i;
// What legitimately belongs in the shipped folder: the encoded portraits and
// the anchors file the panel fetches. Everything else here is authoring
// material (masters, README, .gitkeep) and is left out of the build.
const KEEP_IN_DIST = /(\.webp|anchors\.json)$/i;

type Sharp = typeof import('sharp');

// Loaded lazily and tolerated if missing: a machine without a usable sharp
// binary should still produce a working build, just an unoptimised one.
let sharpModule: Sharp | null | undefined;
async function loadSharp(): Promise<Sharp | null> {
    if (sharpModule !== undefined) return sharpModule;
    try {
        sharpModule = (await import('sharp')).default as unknown as Sharp;
    } catch {
        sharpModule = null;
    }
    return sharpModule;
}

async function listSources(): Promise<string[]> {
    try {
        return (await fs.readdir(SOURCE_DIR)).filter(name => SOURCE_PATTERN.test(name));
    } catch {
        return [];
    }
}

async function encode(sharp: Sharp, sourcePath: string): Promise<Buffer> {
    return sharp(sourcePath)
        // `inside` fits the image within the box without distorting it, so
        // whichever edge is longer becomes MAX_EDGE. Never upscales.
        .resize({width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true})
        .webp({quality: WEBP_QUALITY})
        .toBuffer();
}

// The name the panel will actually request this portrait under. Run through
// the app's own slug rule rather than used verbatim, so a master saved as
// "Exeggcute.png" or "Mr. Mime.png" still lands on the URL the panel asks
// for - otherwise it emits a file nothing ever requests, and the portrait
// silently falls back to the placeholder on case-sensitive hosting.
function slugOf(file: string): string {
    return slugifySpecies(file.replace(SOURCE_PATTERN, ''));
}

export function portraitsPlugin(): Plugin {
    return {
        name: 'crunchatize-portraits',

        // Dev serves the same .webp URLs the built stage uses, converting on
        // demand, so what you see with `yarn dev` matches what deploys.
        configureServer(server: ViteDevServer) {
            const cache = new Map<string, {mtimeMs: number; body: Buffer}>();

            server.middlewares.use(async (req, res, next) => {
                const url = (req.url ?? '').split('?')[0];
                if (!url.startsWith(URL_PREFIX) || !url.endsWith('.webp')) return next();

                const slug = path.basename(url, '.webp');
                const sources = await listSources();
                // The requested .webp may not exist on disk; find whichever
                // master shares its name.
                const source = sources.find(name => slugOf(name) === slug);
                if (!source) return next();

                const sourcePath = path.join(SOURCE_DIR, source);
                const sharp = await loadSharp();
                if (!sharp) return next();

                try {
                    const {mtimeMs} = await fs.stat(sourcePath);
                    let entry = cache.get(slug);
                    if (!entry || entry.mtimeMs !== mtimeMs) {
                        entry = {mtimeMs, body: await encode(sharp, sourcePath)};
                        cache.set(slug, entry);
                    }
                    res.setHeader('Content-Type', 'image/webp');
                    res.end(entry.body);
                } catch {
                    next();
                }
            });
        },

        // Runs after Vite has copied public/ into dist/, so this replaces the
        // copied masters rather than racing them.
        async closeBundle() {
            const sources = await listSources();
            if (sources.length === 0) return;

            const sharp = await loadSharp();
            if (!sharp) {
                this.warn(
                    'sharp is unavailable, so portraits could not be optimised. The build still works, ' +
                    'but full-size masters are being shipped. Run `yarn install` to restore it.'
                );
                return;
            }

            await fs.mkdir(DIST_DIR, {recursive: true});

            let sourceBytes = 0;
            let outputBytes = 0;
            for (const source of sources) {
                const body = await encode(sharp, path.join(SOURCE_DIR, source));
                await fs.writeFile(path.join(DIST_DIR, `${slugOf(source)}.webp`), body);
                sourceBytes += (await fs.stat(path.join(SOURCE_DIR, source))).size;
                outputBytes += body.length;
            }

            // Drop the copied masters (and authoring files) from the build.
            for (const name of await fs.readdir(DIST_DIR)) {
                if (!KEEP_IN_DIST.test(name)) {
                    await fs.rm(path.join(DIST_DIR, name), {force: true});
                }
            }

            const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
            console.log(
                `\x1b[32m✓\x1b[0m portraits: ${sources.length} → WebP @ ${MAX_EDGE}px ` +
                `(${mb(sourceBytes)} → ${mb(outputBytes)})`
            );
        }
    };
}
