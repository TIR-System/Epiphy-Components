#version 150

uniform sampler2D Sampler0;
uniform sampler2D Sampler1;
uniform vec4 ColorModulator;
uniform vec2 MaskThreshold;

in vec4 vertexColor;
in vec2 texCoord0;
in vec2 maskCoord1;

out vec4 fragColor;

void main() {
    vec4 base = texture(Sampler0, texCoord0) * vertexColor * ColorModulator;
    vec4 maskSample = texture(Sampler1, maskCoord1);
    float maskLuma = dot(maskSample.rgb, vec3(0.299, 0.587, 0.114));
    float maskWeight = maskSample.a * max(maskLuma, step(0.999, maskSample.a) == 0.0 ? 1.0 : maskLuma);
    float lo = MaskThreshold.x;
    float hi = max(lo + 0.0001, MaskThreshold.y);
    float alphaFactor = smoothstep(lo, hi, maskWeight);
    float finalAlpha = base.a * alphaFactor;
    if (finalAlpha < 0.002) {
        discard;
    }
    fragColor = vec4(base.rgb, finalAlpha);
}
