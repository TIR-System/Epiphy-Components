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

float fbm3(vec2 p, float periodX) {
    float v = 0.0;
    float a = 0.55;
    float per = periodX;
    for (int i = 0; i < 3; i++) {
        v += a * valueNoise(p, per);
        p *= 2.0;
        per *= 2.0;
        a *= 0.48;
    }
    return v;
}

vec3 starTint(float h) {
    if (h < 0.36) return vec3(0.45, 0.98, 0.94); // Luminous cyan-mint
    if (h < 0.68) return vec3(0.55, 0.84, 1.00); // Glacial starlight blue
    if (h < 0.86) return vec3(0.84, 0.62, 1.00); // Astral lilac-violet
    return vec3(1.00, 0.92, 0.72);               // Celestial warm white-gold
}

// 3x3 periodic star layer with crisp 4-point cross flares (+) and soft radial nebula blooms
vec3 evalCrossStarLayer(vec2 uv, float gridScale, float periodCells, float t, float density, float sizeScale, float crossStrength) {
    vec2 p = uv * gridScale;
    vec2 id = floor(p);
    vec2 gv = fract(p) - 0.5;
    vec3 acc = vec3(0.0);

    for (int oy = -1; oy <= 1; oy++) {
        for (int ox = -1; ox <= 1; ox++) {
            vec2 offs = vec2(float(ox), float(oy));
            vec2 cid = id + offs;
            float cx = wrapCoord(cid.x, periodCells);
            vec2 key = vec2(cx, cid.y);

            float spawn = hash21(key + vec2(17.3, 41.9));
            if (spawn > density) continue;

            vec2 rnd = hash22(key + vec2(3.7, 9.1));
            vec2 starPos = offs + (rnd - 0.5) * 0.72;
            vec2 d = (gv - starPos) / max(sizeScale * (0.65 + 0.75 * rnd.x), 0.15);

            float dist2 = dot(d, d);
            if (dist2 > 1.8) continue;

            float phase = hash21(key + vec2(71.1, 13.7));
            float twinkle = 0.72 + 0.28 * sin(t * (2.1 + phase * 3.2) + phase * TWO_PI);

            float ax = abs(d.x);
            float ay = abs(d.y);

            // Crisp 4-point cross-star (+) + incandescent white core + soft cosmic halo
            float crossH = exp(-ay * 42.0) * exp(-ax * 7.2);
            float crossV = exp(-ax * 42.0) * exp(-ay * 7.2);
            float diamond = exp(-(ax + ay) * 20.0) * 0.42;
            float core = exp(-dist2 * 125.0);
            float halo = exp(-dist2 * 10.5) * 0.52;

            vec3 tint = starTint(rnd.y);
            float flare = (crossH + crossV) * crossStrength + diamond;
            vec3 starCol = tint * (halo + flare * 0.95) + vec3(1.0) * (core * 1.45 + flare * 0.48);
            acc += starCol * twinkle;
        }
    }
    return acc;
}

// Fast 1x1 deep-field pinpoint star layer (zero neighbor loop)
vec3 evalPinpointLayer(vec2 uv, float gridScale, float periodCells, float t) {
    vec2 p = uv * gridScale;
    vec2 id = floor(p);
    vec2 gv = fract(p) - 0.5;
    vec2 key = vec2(wrapCoord(id.x, periodCells), id.y);
    float spawn = hash21(key + vec2(53.1, 29.7));
    if (spawn > 0.45) return vec3(0.0);
    vec2 rnd = hash22(key + vec2(11.3, 5.9));
    vec2 d = gv - (rnd - 0.5) * 0.68;
    float dist2 = dot(d, d);
    float twinkle = 0.65 + 0.35 * sin(t * (1.8 + rnd.x * 3.0) + rnd.y * TWO_PI);
    float pt = exp(-dist2 * 90.0);
    return mix(starTint(rnd.y), vec3(1.0), 0.55) * pt * twinkle;
}

vec3 evalCosmosField(vec2 uv, float periodUV, float t, float isRift) {
    // 1. Deep cosmic void base (dark enough that stars & nebulae pop dramatically)
    vec3 col = vec3(0.012, 0.026, 0.058);

    // 2. Multi-octave flowing emerald-teal / cyan / astral-violet nebula clouds
    float n1 = fbm3(uv * 9.0 + vec2(t * 0.032, -t * 0.022), periodUV * 9.0);
    float n2 = fbm3(uv * 15.0 + vec2(-t * 0.026 + n1 * 0.65, t * 0.030 - n1 * 0.40), periodUV * 15.0);
    float n3 = fbm3(uv * 22.0 + vec2(t * 0.018, t * 0.024), periodUV * 22.0);

    float tealBand   = smoothstep(0.32, 0.80, n1 * 0.62 + n2 * 0.52);
    float cyanPocket = smoothstep(0.50, 0.88, n2 * 0.70 + n3 * 0.45);
    float violetWisp = smoothstep(0.44, 0.86, (1.0 - n1) * 0.55 + n3 * 0.60);

    col += vec3(0.03, 0.30, 0.34) * tealBand * 0.92;
    col += vec3(0.10, 0.74, 0.78) * cyanPocket * 0.76;
    col += vec3(0.26, 0.13, 0.60) * violetWisp * 0.54;
    col += vec3(0.58, 0.16, 0.54) * smoothstep(0.62, 0.92, n3) * (0.28 + 0.34 * isRift);

    // 3. Layer 1: Hero foreground glowing 4-point cross-stars (+) with soft blooms (~2-4 visible in blade window)
    col += evalCrossStarLayer(uv + vec2(t * 0.003, -t * 0.002), 18.0, periodUV * 18.0, t, 0.42, 1.05, 1.25);

    // 4. Layer 2: Mid-depth crisp cyan/ice-blue cross-stars (parallax drift)
    col += evalCrossStarLayer(uv + vec2(-t * 0.005, t * 0.004), 30.0, periodUV * 30.0, t * 1.15, 0.46, 0.74, 0.88) * 0.85;

    // 5. Layer 3: Fast 1x1 deep-field micro pinpoint starfield
    col += evalPinpointLayer(uv + vec2(t * 0.002, t * 0.003), 52.0, periodUV * 52.0, t * 0.9) * 0.72;

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
        // Hotbar / inventory GUI slot: calibrated to show 2-3 crisp hero cross-stars & nebula inside the 16x16 slot
        vec2 guiUV = texCoord0 * vec2(0.68, 0.68) + vec2(t * 0.018, -t * 0.012);
        cosmosCol = evalCosmosField(guiUV, 0.0, t, isRift);
    } else {
        // World / first-person / third-person: true camera-locked 3D view-ray parallax!
        vec3 ray = normalize(viewPos);
        float yaw = EpiphyYawPitch.x;
        float pitch = EpiphyYawPitch.y;
        float cy = cos(yaw);
        float sy = sin(yaw);
        float cp = cos(pitch);
        float sp = sin(pitch);

        // Rotate view ray from camera space back into world space
        vec3 rPitch = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
        vec3 wRay = normalize(vec3(rPitch.x * cy - rPitch.z * sy, rPitch.y, rPitch.x * sy + rPitch.z * cy));

        // Seamless 360-degree equirectangular projection (2:1 isotropic aspect -> periodUV = 2.0)
        float lon = atan(wRay.x, -wRay.z) / TWO_PI + 0.5;
        float lat = asin(clamp(wRay.y, -0.999, 0.999)) / PI + 0.5;
        vec2 eqUV = vec2(lon * 2.0, lat);

        vec3 eqCol = evalCosmosField(eqUV, 2.0, t, isRift);

        // Smooth polar-cap blend near zenith/nadir so looking straight up/down has zero pinching
        float poleMix = smoothstep(0.70, 0.94, abs(wRay.y));
        if (poleMix > 0.001) {
            vec2 poleUV = wRay.xz * 0.85 + vec2(0.5);
            vec3 poleCol = evalCosmosField(poleUV, 0.0, t, isRift);
            cosmosCol = mix(eqCol, poleCol, poleMix);
        } else {
            cosmosCol = eqCol;
        }
    }

    // Upper-blade 1px scissor-rift boost: crisp astral starlight seam
    if (isRift > 0.5) {
        float riftPulse = 0.88 + 0.22 * sin(t * 3.4 - texCoord0.y * 18.0 + texCoord0.x * 14.0);
        cosmosCol = cosmosCol * 1.28 + vec3(0.08, 0.24, 0.36) * riftPulse;
    }

    // Subtle Ark concentric metallic ring sheen etched across the lower-blade cosmic window
    if (ringRidge > 0.02) {
        float sheenWave = 0.45 + 0.55 * sin(t * 2.4 + (texCoord0.x - texCoord0.y) * 14.0);
        cosmosCol += vec3(0.45, 0.82, 0.96) * ringRidge * sheenWave * 0.22;
    }

    // Gentle recessed portal bevel right where the cosmic void meets the sword metal
    cosmosCol *= (0.76 + 0.24 * innerFactor);

    // Subtle tone-compression so super-bright overlapping stars keep crisp saturated halos
    cosmosCol = cosmosCol / (1.0 + cosmosCol * 0.18);

    fragColor = vec4(clamp(cosmosCol, 0.0, 1.0), 1.0) * vertexColor * ColorModulator;
}
