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

// Seamless 3D hashes (operating directly on 3D spherical shell cells -> zero meridian/pole seams!)
float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
}

// Smooth 3D value noise (continuous everywhere on S^2, zero UV seam)
float valueNoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);

    float n000 = hash31(i + vec3(0.0, 0.0, 0.0));
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));

    float nx00 = mix(n000, n100, u.x);
    float nx10 = mix(n010, n110, u.x);
    float nx01 = mix(n001, n101, u.x);
    float nx11 = mix(n011, n111, u.x);

    float nxy0 = mix(nx00, nx10, u.y);
    float nxy1 = mix(nx01, nx11, u.y);
    return mix(nxy0, nxy1, u.z);
}

// Fast 2-octave 3D FBM for silky deep-space nebulae
float fbm3(vec3 p) {
    float v = 0.64 * valueNoise3(p);
    v += 0.36 * valueNoise3(p * 2.07 + vec3(13.7, -7.3, 5.1));
    return v;
}

vec3 starTint(float h) {
    if (h < 0.24) return vec3(0.45, 0.96, 1.00); // Crisp ice-cyan
    if (h < 0.50) return vec3(0.62, 0.80, 1.00); // Sapphire starlight
    if (h < 0.72) return vec3(0.92, 0.62, 1.00); // Astral violet-lilac
    if (h < 0.88) return vec3(1.00, 0.66, 0.86); // Nebula rose-pink
    return vec3(1.00, 0.90, 0.62);               // Warm celestial gold
}

// Zero-seam 3D pinpoint star shell: star center strictly clamped inside [-0.26, +0.26]^3
// and multiplied by smoothstep(0.24, 0.04, dist) so contribution is EXACTLY 0 at cell boundaries!
vec3 evalStarShell3D(vec3 dir, float shellRadius, float density, float sharpness, float t, vec3 seed, float haloAmt) {
    vec3 p = dir * shellRadius + seed;
    vec3 id = floor(p);
    vec3 gv = fract(p) - 0.5;

    float spawn = hash31(id + seed * 0.37);
    if (spawn > density) return vec3(0.0);

    vec3 rnd = hash33(id + seed * 0.71);
    vec3 center = (rnd - 0.5) * 0.52;
    vec3 d = gv - center;
    float d2 = dot(d, d);
    if (d2 > 0.0576) return vec3(0.0); // 0.24^2 exact boundary cutoff -> zero tile seam!

    float dist = sqrt(d2);
    float edgeFade = smoothstep(0.24, 0.04, dist);
    float twinkle = 0.66 + 0.34 * sin(t * (2.0 + rnd.x * 3.4) + rnd.z * TWO_PI);

    float core = exp(-d2 * sharpness);
    float halo = exp(-d2 * (sharpness * 0.16)) * haloAmt;
    vec3 tint = starTint(rnd.y);
    vec3 col = tint * halo + mix(tint, vec3(1.0), 0.72) * core;
    return col * edgeFade * twinkle;
}

// Zero-seam 3D razor-sharp 4-point diamond cross-star layer projected onto local tangent plane
vec3 evalHeroCrossStars(vec3 dir, float shellRadius, float t) {
    vec3 p = dir * shellRadius + vec3(4.2, -9.1, 17.5);
    vec3 id = floor(p);
    vec3 gv = fract(p) - 0.5;

    float spawn = hash31(id + vec3(19.7, 43.1, 7.3));
    if (spawn > 0.34) return vec3(0.0);

    vec3 rnd = hash33(id + vec3(3.1, 11.9, 27.4));
    vec3 center = (rnd - 0.5) * 0.48;
    vec3 d = gv - center;
    float d2 = dot(d, d);
    if (d2 > 0.0625) return vec3(0.0); // 0.25^2 exact boundary cutoff

    float dist = sqrt(d2);
    float edgeFade = smoothstep(0.25, 0.03, dist);

    // Local tangent basis perpendicular to view ray so cross spikes stay crisp from any angle
    vec3 upRef = (abs(dir.y) < 0.92) ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 t1 = normalize(cross(upRef, dir));
    vec3 t2 = cross(dir, t1);

    float u = dot(d, t1);
    float v = dot(d, t2);
    float au = abs(u);
    float av = abs(v);
    float planeD2 = u * u + v * v;

    float twinkle = 0.74 + 0.26 * sin(t * (2.4 + rnd.x * 2.8) + rnd.z * TWO_PI);
    float spikeH = exp(-av * 92.0) * exp(-au * 14.5);
    float spikeV = exp(-au * 92.0) * exp(-av * 14.5);
    // Subtle diagonal diamond glint
    float du = abs(u + v) * 0.7071;
    float dv = abs(u - v) * 0.7071;
    float diag = (exp(-dv * 115.0) * exp(-du * 26.0) + exp(-du * 115.0) * exp(-dv * 26.0)) * 0.42;

    float core = exp(-planeD2 * 380.0);
    float halo = exp(-planeD2 * 44.0) * 0.34;
    vec3 tint = starTint(rnd.y);
    float flare = (spikeH + spikeV + diag) * 1.15;

    return (tint * (halo + flare * 0.85) + vec3(1.0) * (core * 1.55 + flare * 0.52)) * edgeFade * twinkle;
}

vec3 rotateY(vec3 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}

vec3 rotateX(vec3 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec3(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

vec3 evalCosmosField3D(vec3 dir, float t, float isRift) {
    // 1. True deep-space midnight obsidian-indigo base (crisp contrast for pinpoint stars)
    vec3 col = vec3(0.008, 0.007, 0.024);

    // Slowly drifting celestial sphere
    vec3 driftDir = normalize(rotateY(rotateX(dir, t * 0.008), t * 0.014));

    // 2. Silky multi-tone 3D domain-warped nebula filaments (zero meridian or pole seam!)
    float n1 = fbm3(driftDir * 4.2 + vec3(t * 0.015, -t * 0.010, t * 0.012));
    float n2 = fbm3(driftDir * 7.8 + vec3(n1 * 1.15 - t * 0.012, -n1 * 0.85 + t * 0.014, n1 * 0.65));
    float n3 = valueNoise3(driftDir * 15.5 + vec3(n2 * 0.9, -n1 * 0.7, t * 0.018));

    // Equatorial galactic dust belt tilted diagonally across the sky sphere
    float galPlane = abs(dot(driftDir, normalize(vec3(0.32, 0.78, -0.54))));
    float galBand = exp(-galPlane * galPlane * 7.5);

    float deepBlue  = smoothstep(0.34, 0.80, n1 * 0.70 + n2 * 0.35) * (0.55 + 0.45 * galBand);
    float royalViol = smoothstep(0.42, 0.86, (1.0 - n1) * 0.50 + n2 * 0.65);
    float roseWisp  = pow(smoothstep(0.50, 0.90, n2 * 0.68 + n3 * 0.38), 1.65);
    float cyanVein  = pow(smoothstep(0.58, 0.94, n3 * 0.65 + n2 * 0.45), 2.35) * (0.65 + 0.55 * isRift);

    // Dark cosmic dust lanes carving depth into the nebula
    float dustLane = smoothstep(0.40, 0.78, valueNoise3(driftDir * 9.5 + vec3(5.2, -3.1, 8.4)));
    float dustMask = 1.0 - dustLane * 0.46;

    col += vec3(0.055, 0.140, 0.420) * deepBlue * 0.78 * dustMask;
    col += vec3(0.340, 0.095, 0.680) * royalViol * 0.72 * dustMask;
    col += vec3(0.720, 0.155, 0.540) * roseWisp * (0.48 + 0.24 * isRift);
    col += vec3(0.100, 0.660, 0.920) * cyanVein * 0.76;

    // 3. Four seamless, parallax-separated, razor-sharp 3D star shells
    vec3 dirFar  = normalize(rotateY(dir, t * 0.004));
    vec3 dirMid  = normalize(rotateY(dir, t * 0.009));
    vec3 dirNear = normalize(rotateX(rotateY(dir, t * 0.015), -t * 0.005));

    // Layer A: Dense pinpoint distant galactic stardust
    col += evalStarShell3D(dirFar,  148.0, 0.62, 460.0, t * 0.80, vec3(11.3, 27.1, 41.9), 0.12) * 0.78;
    // Layer B: Crisp mid-field jewel stars
    col += evalStarShell3D(dirMid,   92.0, 0.54, 320.0, t * 1.00, vec3(53.7, 13.4, 29.2), 0.22) * 0.92;
    // Layer C: Bright foreground stars with controlled tight glow
    col += evalStarShell3D(dirNear,  54.0, 0.42, 230.0, t * 1.15, vec3(7.9, 61.3, 19.8), 0.28) * 1.05;
    // Layer D: Hero razor-sharp 4-point diamond cross-stars
    col += evalHeroCrossStars(dirNear, 30.0, t) * 1.12;

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

    vec3 wRay;
    if (EpiphyGuiMode > 0.5) {
        // Smooth portal cone ray for crisp GUI icon preview (same seamless 3D cosmos kernel)
        vec2 centered = (texCoord0 - vec2(0.5)) * 0.82;
        wRay = normalize(rotateY(vec3(centered.x, -centered.y, -1.0), t * 0.14));
    } else {
        // Camera-locked 3D view-ray parallax with subtle window-depth refraction
        vec3 ray = normalize(viewPos);
        float yaw = EpiphyYawPitch.x;
        float pitch = EpiphyYawPitch.y;
        vec3 rPitch = rotateX(ray, pitch);
        wRay = normalize(rotateY(rPitch, yaw));
    }

    vec3 cosmosCol = evalCosmosField3D(wRay, t, isRift);

    // Rift enhancement: deepen richness & add subtle starlight shimmer without washing out black void
    if (isRift > 0.5) {
        float riftShimmer = 0.94 + 0.14 * sin(t * 2.8 - texCoord0.y * 16.0 + texCoord0.x * 12.0);
        cosmosCol *= (1.22 * riftShimmer);
    }

    // Subtle metallic-astral rim sheen on recessed ridge pixels
    if (ringRidge > 0.02) {
        float sheenWave = 0.40 + 0.60 * sin(t * 2.2 + (texCoord0.x - texCoord0.y) * 12.0);
        cosmosCol += vec3(0.42, 0.68, 1.00) * ringRidge * sheenWave * 0.20;
    }

    // Recessed portal vignette: darkens outer rim slightly so cosmos reads as a true deep-set rift
    float depthVignette = mix(0.62, 1.04, smoothstep(0.0, 0.85, innerFactor));
    cosmosCol *= depthVignette;

    // Gentle filmic shoulder preserving vivid nebula hues & crisp white star cores
    cosmosCol = cosmosCol / (1.0 + cosmosCol * 0.22);

    fragColor = vec4(clamp(cosmosCol, 0.0, 1.0), 1.0) * vertexColor * ColorModulator;
}
