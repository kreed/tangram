// Texture management
import Utils from '../utils/utils';
import subscribeMixin from '../utils/subscribe';
import WorkerBroker from '../utils/worker_broker';
import Builders from '../styles/builders';
import log from 'loglevel';

// GL texture wrapper object for keeping track of a global set of textures, keyed by a unique user-defined name
export default class Texture {

    constructor(gl, name, options = {}) {
        this.gl = gl;
        this.texture = gl.createTexture();
        if (this.texture) {
            this.valid = true;
        }
        this.bind();

        this.name = name;
        this.source = null;
        this.source_type = null;
        this.loading = null;    // a Promise object to track the loading state of this texture
        this.filtering = options.filtering;
        this.sprites = options.sprites;
        this.texcoords = {};    // sprite UVs ([0, 1] range)
        this.sizes = {};        // sprite sizes (pixel size)

        // Default to a 1-pixel black texture so we can safely render while we wait for an image to load
        // See: http://stackoverflow.com/questions/19722247/webgl-wait-for-texture-to-load
        this.setData(1, 1, new Uint8Array([0, 0, 0, 255]), { filtering: 'nearest' });

        // Destroy previous texture if present
        if (Texture.textures[this.name]) {
            Texture.textures[this.name].destroy();
        }

        // Cache texture instance and definition
        Texture.textures[this.name] = this;
        Texture.texture_configs[this.name] = Object.assign({ name }, options);
        
        this.load(options);
        log.trace(`creating Texture ${this.name}`);
    }

    // Destroy a single texture instance
    destroy() {
        if (!this.valid) {
            return;
        }
        this.gl.deleteTexture(this.texture);
        this.texture = null;
        delete this.data;
        this.data = null;
        delete Texture.textures[this.name];
        this.valid = false;
        log.trace(`destroying Texture ${this.name}`);
    }

    bind(unit) {
        if (!this.valid) {
            return;
        }
        if (typeof unit === 'number') {
            if (Texture.activeUnit !== unit) {
                this.gl.activeTexture(this.gl.TEXTURE0 + unit);
                Texture.activeUnit = unit;
            }
        }
        if (Texture.activeTexture !== this.texture) {
            this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
            Texture.activeTexture = this.texture;
        }
    }

    load(options = {}) {
        if (typeof options.url === 'string') {
            return this.setUrl(options.url, options);   
        } else if (options.canvas instanceof HTMLCanvasElement) {
            return this.setCanvas(options.canvas, options);
        } else if (options.image instanceof HTMLImageElement) {
            return this.setImage(options.image, options);
        } else if (options.data && options.width && options.height) {
            return this.setData(options.width, options.height, options.data, options);
        }
    }

    // Sets texture from an url
    setUrl(url, options = {}) {
        if (!this.valid) {
            return;
        }

        if (Texture.base_url) {
            url = Utils.addBaseURL(url, Texture.base_url);
        }

        this.source = Utils.cacheBusterForUrl(url);
        this.source_type = 'url';

        this.loading = new Promise((resolve, reject) => {
            let image = new Image();
            image.onload = () => {
                try {
                    this.setImage(image, options);
                    // this.update(options);
                    // this.setTextureFiltering(options);
                    this.calculateSprites();
                }
                catch (e) {
                    log.warn(`Texture: failed to load url: '${url}'`, e, options);
                    Texture.trigger('warning', { message: `Failed to load texture from ${url}`, error: e, texture: options });
                }

                resolve(this);
            };
            image.onerror = e => {
                // Warn and resolve on error
                log.warn(`Texture: failed to load url: '${url}'`, e, options);
                Texture.trigger('warning', { message: `Failed to load texture from ${url}`, error: e, texture: options });
                resolve(this);
            };
            image.crossOrigin = 'anonymous';
            image.src = url;
        });
        return this.loading;
    }

    // Sets texture to a raw image buffer
    setData(width, height, data, options = {}) {
        this.width = width;
        this.height = height;

        this.source = data;
        this.source_type = 'data';

        this.update(options);
        this.setTextureFiltering(options);

        this.loading = Promise.resolve(this);
        return this.loading;
    }

    // Sets the texture to track a canvas element
    setCanvas(canvas, options) {
        this.source = canvas;
        this.source_type = 'canvas';

        this.update(options);
        this.setTextureFiltering(options);

        this.loading = Promise.resolve(this);
        return this.loading;
    }

    setImage(image, options) {
        this.source = image;
        this.source_type = 'image';

        this.update(options);
        this.setTextureFiltering(options);

        this.loading = Promise.resolve(this);
        return this.loading;
    }

    // Uploads current image or buffer to the GPU (can be used to update animated textures on the fly)
    update(options = {}) {
        if (!this.valid) {
            return;
        }

        this.bind();
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, (options.UNPACK_FLIP_Y_WEBGL === false ? false : true));
        this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, options.UNPACK_PREMULTIPLY_ALPHA_WEBGL || false);

        // Image or Canvas element
        if (this.source_type === 'canvas' || (this.source_type === 'image' && this.source.complete)) {
            this.width = this.source.width;
            this.height = this.source.height;
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.source);
        }
        // Raw image buffer
        else if (this.source_type === 'data') { // NOTE: this.data can be null, to zero out texture
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.width, this.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.source);
        }

        Texture.trigger('update', this);
    }

    // Determines appropriate filtering mode
    setTextureFiltering(options = {}) {
        if (!this.valid) {
            return;
        }

        options.filtering = options.filtering || this.filtering || 'linear';

        var gl = this.gl;
        this.bind();

        // For power-of-2 textures, the following presets are available:
        // mipmap: linear blend from nearest mip
        // linear: linear blend from original image (no mips)
        // nearest: nearest pixel from original image (no mips, 'blocky' look)
        if (Utils.isPowerOf2(this.width) && Utils.isPowerOf2(this.height)) {
            this.power_of_2 = true;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.TEXTURE_WRAP_S || (options.repeat && gl.REPEAT) || gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.TEXTURE_WRAP_T || (options.repeat && gl.REPEAT) || gl.CLAMP_TO_EDGE);

            // gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, options.TEXTURE_WRAP_S || gl.REPEAT);
            // gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, options.TEXTURE_WRAP_T || gl.REPEAT);

            if (options.filtering === 'mipmap') {
                this.filtering = 'mipmap';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); // TODO: use trilinear filtering by defualt instead?
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.generateMipmap(gl.TEXTURE_2D);
            }
            else if (options.filtering === 'linear') {
                this.filtering = 'linear';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            }
            else if (options.filtering === 'nearest') {
                this.filtering = 'nearest';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            }
        }
        else {
            // WebGL has strict requirements on non-power-of-2 textures:
            // No mipmaps and must clamp to edge
            this.power_of_2 = false;
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

            if (options.filtering === 'nearest') {
                this.filtering = 'nearest';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            }
            else { // default to linear for non-power-of-2 textures
                this.filtering = 'linear';
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            }
        }

        Texture.trigger('update', this);
    }

    // Pre-calc sprite regions for a texture sprite in UV [0, 1] space
    calculateSprites() {
        if (this.sprites) {
            for (let s in this.sprites) {
                let sprite = this.sprites[s];

                // Map [0, 0] to [1, 1] coords to the appropriate sprite sub-area of the texture
                this.texcoords[s] = Builders.getTexcoordsForSprite(
                    [sprite[0], sprite[1]],
                    [sprite[2], sprite[3]],
                    [this.width, this.height]
                );

                // Pixel size of sprite
                this.sizes[s] = [sprite[2], sprite[3]];
            }
        }
    }

}


// Static/class methods and state

// Destroy all texture instances for a given GL context
Texture.destroy = function (gl) {
    var textures = Object.keys(Texture.textures);
    for (var t of textures) {
        var texture = Texture.textures[t];
        if (texture.gl === gl) {
            texture.destroy();
        }
    }
};

// Get sprite pixel size and UVs
Texture.getSpriteInfo = function (texname, sprite) {
    let texture = Texture.textures[texname];
    return texture && { size: texture.sizes[sprite], texcoords: texture.texcoords[sprite] };
};

// Create a set of textures keyed in an object
// Optionally load each if it has a URL specified
Texture.createFromObject = function (gl, textures) {
    let loading = [];
    if (textures) {
        for (let texname in textures) {
            let config = textures[texname];

            // If texture already exists and definition hasn't changed, no need to re-create
            // Note: to avoid flicker when other textures/scene items change
            if (!Texture.changed(texname, config)) {
                continue;
            }

            let texture = new Texture(gl, texname, config);
            loading.push(texture.loading);
        }
    }
    return Promise.all(loading);
};

// Indicate if a texture definition would be a change from the current cache
Texture.changed = function (name, config) {
    if (Texture.textures[name]) { // cached texture
        // compare definitions
        // TODO: fix for canvas/image/data
        if (JSON.stringify(Texture.texture_configs[name]) ===
            JSON.stringify(Object.assign({ name }, config))) {
            return false;
        }
    }
    return true;
};

// Get metadata for a texture by name
// Returns via promise, in case texture is still loading
// Can be called on main thread from worker, to sync texture info to worker
Texture.getInfo = function (name) {
    // Get info for all textures by default
    if (!name) {
        name = Object.keys(Texture.textures);
    }

    // Get multiple textures
    if (Array.isArray(name)) {
        return Promise.all(name.map(n => Texture.getInfo(n)));
    }

    // Get single texture
    var tex = Texture.textures[name];
    if (tex) {
        // Wait for this texture to finish loading, or return immediately
        var loading = tex.loading || Promise.resolve(tex);
        return loading.then(() => {
            // Return a subset of texture info
            // (compatible w/structured cloning, suitable for passing to a worker)
            return {
                name: tex.name,
                width: tex.width,
                height: tex.height,
                sprites: tex.sprites,
                texcoords: tex.texcoords,
                sizes: tex.sizes,
                filtering: tex.filtering,
                power_of_2: tex.power_of_2,
                valid: tex.valid
            };
        });
    }
    else {
        // No texture found
        return Promise.resolve(null);
    }
};

// Sync texture info to worker
// Called from worker, gets info on one or more textures info from main thread via remote call, then stores it
// locally in worker. 'textures' can be an array of texture names to sync, or if null, all textures are synced.
Texture.syncTexturesToWorker = function (names) {
    return WorkerBroker.postMessage('Texture.getInfo', names).
        then(textures => {
            for (var tex of textures) {
                Texture.textures[tex.name] = tex;
            }
            return Texture.textures;
        });
};

// Report max texture size for a GL context
Texture.getMaxTextureSize = function (gl) {
    return gl.getParameter(gl.MAX_TEXTURE_SIZE);
};

// Global set of textures, by name
Texture.textures = {};
Texture.texture_configs = {};
Texture.boundTexture = -1;
Texture.activeUnit = -1;

Texture.base_url = null; // optional base URL to add to textures

WorkerBroker.addTarget('Texture', Texture);
subscribeMixin(Texture);
