#version 150

uniform sampler2D Sampler0;

uniform vec4 ColorModulator;
uniform float EpiphyTime;
uniform vec2 EpiphyYawPitch;
uniform float EpiphyGuiMode;

in vec4 vertexColor;
in vec2 texCoord0;
in vec3 viewPos;

out vec4 fragColor;

const float PI = 3.14159265;
const float TWO_PI = 6.28318530;

float hash21(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 34.53);
    return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

float wrapCoord(float x, float period) {
    return (period > 0.5) ? mod(mod(x, period) + period, period) : x;
}

float valueNoise(vec2 p, float periodX) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);

    float x0 = wrapCoord(i.x, periodX);
    float x1 = wrapCoord(i.x + 1.0, periodX);

    float a = hash21(vec2(x0, i.y));
    float b = hash21(vec2(x1, i.y));
    float c = hash21(vec2(x0, i.y + 1.0));
    float d = hash21(vec2(x1, i.y + 1.0));

    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Fast 2-octave fractal value noise (low ALU cost for high FPS)
float fbm2(vec2 p, float periodX) {
    float v = 0.62 * valueNoise(p, periodX);
    v += 0.38 * valueNoise(p * 2.0, periodX * 2.0);
    return v;
}

vec3 starTint(float h) {
    if (h < 0.35) return vec3(0.42, 1.00, 0.96); // Luminous cyan-mint
    if (h < 0.68) return vec3(0.54, 0.86, 1.00); // Glacial starlight blue
    if (h < 0.86) return vec3(0.88, 0.60, 1.00); // Astral lilac-violet
    return vec3(1.00, 0.94, 0.72);               // Celestial warm gold-white
}

// Single lightweight 3x3 hero 4-point cross-star layer (+) with soft bloom
vec3 evalHeroCrossStars(vec2 uv, float gridScale, float periodCells, float t) {
    vec2 p = uv * gridScale;
    vec2 id = floor(p);
    vec2 gv = fract(p) - 0.5;
    vec3 acc = vec3(0.0);

    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            vec2 offs = vec2(float(ox), float(oy));
            vec2 cid = id + offs;
            vec2 key = vec2(wrapCoord(cid.x, periodCells), cid.y);

            float spawn = hash21(key + vec2(17.3, 41.9));
            if (spawn > 0.46) continue;

            vec2 rnd = hash22(key + vec2(3.7, 9.1));
            vec2 d = (gv - (offs + (rnd - 0.5) * 0.70)) / (0.68 + 0.65 * rnd.x);
            float dist2 = dot(d, d);
            if (dist2 > 1.45) continue;

            float twinkle = 0.76 + 0.24 * sin(t * (2.2 + rnd.x * 2.8) + rnd.y * TWO_PI);
            float ax = abs(d.x);
            float ay = abs(d.y);

            float crossH = exp(-ay * 34.0) * exp(-ax * 5.8);
            float crossV = exp(-ax * 34.0) * exp(-ay * 5.8);
            float core   = exp(-dist2 * 96.0);
            float halo   = exp(-dist2 * 9.5) * 0.62;

            vec3 tint = starTint(rnd.y);
            float flare = (crossH + crossV) * 1.35;
            acc += (tint * (halo + flare) + vec3(1.0) * (core * 1.65 + flare * 0.55)) * twinkle;
        }
    }
    return acc;
}

// Fast 1x1 zero-loop star layer (mid + deep-field stars)
vec3 evalFastStars(vec2 uv, float gridScale, float periodCells, float t, float density, float sharpness) {
    vec2 p = uv * gridScale;
    vec2 id = floor(p);
    vec2 gv = fract(p) - 0.5;
    vec2 key = vec2(wrapCoord(id.x, periodCells), id.y);
    float spawn = hash21(key + vec2(53.1, 29.7));
    if (spawn > density) return vec3(0.0);
    vec2 rnd = hash22(key + vec2(11.3, 5.9));
    vec2 d = gv - (rnd - 0.5) * 0.64;
    float dist2 = dot(d, d);
    float twinkle = 0.68 + 0.32 * sin(t * (1.9 + rnd.x * 3.0) + rnd.y * TWO_PI);
    float pt = exp(-dist2 * sharpness);
    float glow = exp(-dist2 * (sharpness * 0.18)) * 0.45;
    return (starTint(rnd.y) * glow + mix(starTint(rnd.y), vec3(1.0), 0.60) * pt) * twinkle;
}

vec3 evalCosmosField(vec2 uv, float periodUV, float t, float isRift) {
    // 1. Deep midnight indigo-violet void base (high contrast for sharp cross-stars)
    vec3 col = vec3(0.016, 0.022, 0.068);

    // 2. Fast 2-layer flowing astral-violet / sapphire / luminous-cyan nebula clouds
    float n1 = fbm2(uv * 8.0 + vec2(t * 0.024, -t * 0.016), periodUV * 8.0);
    float n2 = fbm2(uv * 14.0 + vec2(-t * 0.020 + n1 * 0.55, t * 0.022 - n1 * 0.35), periodUV * 14.0);

    float indigoBand = smoothstep(0.32, 0.80, n1 * 0.65 + n2 * 0.45);
    float cyanPocket = smoothstep(0.52, 0.88, n2 * 0.78 + n1 * 0.30);
    float violetWisp = smoothstep(0.38, 0.84, (1.0 - n1) * 0.58 + n2 * 0.55);

    col += vec3(0.06, 0.22, 0.44) * indigoBand * 0.72;
    col += vec3(0.14, 0.68, 0.86) * cyanPocket * 0.64;
    col += vec3(0.42, 0.16, 0.74) * violetWisp * 0.66;
    col += vec3(0.68, 0.24, 0.62) * smoothstep(0.60, 0.92, n2) * (0.28 + 0.32 * isRift);

    // 3. Single 3x3 hero glowing 4-point cross-star layer (+)
    col += evalHeroCrossStars(uv + vec2(t * 0.0025, -t * 0.0018), 18.0, periodUV * 18.0, t) * 0.92;

    // 4. Two zero-loop 1x1 star layers for depth parallax (very cheap on GPU)
    col += evalFastStars(uv + vec2(-t * 0.004, t * 0.003), 32.0, periodUV * 32.0, t * 1.05, 0.52, 52.0) * 0.84;
    col += evalFastStars(uv + vec2(t * 0.002, t * 0.0025), 54.0, periodUV * 54.0, t * 0.85, 0.46, 90.0) * 0.68;

    return col;
}

void main() {
    vec4 mask = texture(Sampler0, texCoord0);
    if (mask.a < 0.5) {
        discard;
    }

    float isRift = step(mask.r, 0.85);
    float ringRidge = mask.g;
    float innerFactor = mask.b;
    float t = EpiphyTime;

    vec3 cosmosCol;
    if (EpiphyGuiMode > 0.5) {
        vec2 guiUV = texCoord0 * vec2(0.72, 0.72) + vec2(t * 0.018, -t * 0.012);
        cosmosCol = evalCosmosField(guiUV, 0.0, t, isRift);
    } else {
        // Single-pass camera-locked 3D view-ray parallax (never double-evaluates near poles)
        vec3 ray = normalize(viewPos);
        float yaw = EpiphyYawPitch.x;
        float pitch = EpiphyYawPitch.y;
        float cy = cos(yaw);
        float sy = sin(yaw);
        float cp = cos(pitch);
        float sp = sin(pitch);

        vec3 rPitch = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
        vec3 wRay = normalize(vec3(rPitch.x * cy - rPitch.z * sy, rPitch.y, rPitch.x * sy + rPitch.z * cy));

        float lon = atan(wRay.x, -wRay.z) / TWO_PI + 0.5;
        float lat = asin(clamp(wRay.y, -0.999, 0.999)) / PI + 0.5;
        vec2 eqUV = vec2(lon * 2.0, lat);
        cosmosCol = evalCosmosField(eqUV, 2.0, t, isRift);
    }

    if (isRift > 0.5) {
        float riftPulse = 0.90 + 0.22 * sin(t * 3.4 - texCoord0.y * 18.0 + texCoord0.x * 14.0);
        cosmosCol = cosmosCol * 1.32 + vec3(0.10, 0.28, 0.42) * riftPulse;
    }

    if (ringRidge > 0.02) {
        float sheenWave = 0.48 + 0.52 * sin(t * 2.4 + (texCoord0.x - texCoord0.y) * 14.0);
        cosmosCol += vec3(0.48, 0.86, 1.00) * ringRidge * sheenWave * 0.26;
    }

    cosmosCol *= (0.80 + 0.20 * innerFactor);
    cosmosCol = cosmosCol / (1.0 + cosmosCol * 0.16);

    fragColor = vec4(clamp(cosmosCol, 0.0, 1.0), 1.0) * vertexColor * ColorModulator;
}
