import type { GuiProgressShader, GuiSpriteShader } from './types.js';

// This is a bounded colour-expression interpreter, never a JavaScript/HLSL executor.
// Unsupported sampling, geometry, branches and nonlinear colour operations stay explicit.
export const GUI_SHADER_MAX_BYTES = 262_144;
const maxTokens = 4_096;
const maxTokenLength = 256;
const maxDepth = 64;
const maxStatements = 128;
const maxCoefficient = 1_000_000;

export type GuiShaderEffect = 'Up' | 'Over' | 'Down' | 'Disable';
export interface GuiShaderUniforms {
  time: number;
  animationTime: number;
  colour?: readonly [number, number, number, number];
}
export type GuiShaderResult =
  { supported: true; shader: GuiSpriteShader } | { supported: false; reason: string };
export type GuiProgressShaderResult =
  { supported: true; shader: GuiProgressShader } | { supported: false; reason: string };

type Channel = readonly [number, number, number, number, number];
type Value = readonly Channel[];
const constant = (value: number): Channel => [0, 0, 0, 0, value];
const isConstant = (value: Channel): boolean => value.slice(0, 4).every((entry) => entry === 0);
const identity: Value = [
  [1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0],
  [0, 0, 1, 0, 0],
  [0, 0, 0, 1, 0],
];

class UnsupportedShader extends Error {}
function unsupported(reason: string): never {
  throw new UnsupportedShader(reason.length > 512 ? `${reason.slice(0, 509)}...` : reason);
}

function checked(value: number[]): Channel {
  if (
    value.length !== 5 ||
    value.some((entry) => !Number.isFinite(entry) || Math.abs(entry) > maxCoefficient)
  )
    unsupported('Shader colour arithmetic exceeds its finite coefficient budget.');
  return value as [number, number, number, number, number];
}

function binary(left: Value, right: Value, operator: string): Value {
  const width = Math.max(left.length, right.length);
  if (![1, width].includes(left.length) || ![1, width].includes(right.length))
    unsupported('Shader vector widths do not agree.');
  return Array.from({ length: width }, (_, index) => {
    const a = left[left.length === 1 ? 0 : index]!;
    const b = right[right.length === 1 ? 0 : index]!;
    if (operator === '+' || operator === '-')
      return checked(
        a.map((entry, component) => entry + (operator === '+' ? 1 : -1) * b[component]!),
      );
    if (operator === '*') {
      if (isConstant(a)) return checked(b.map((entry) => entry * a[4]));
      if (isConstant(b)) return checked(a.map((entry) => entry * b[4]));
      unsupported('Multiplication of two sampled colour expressions is nonlinear.');
    }
    if (operator === '/' && isConstant(b) && b[4] !== 0)
      return checked(a.map((entry) => entry / b[4]));
    return unsupported('Shader division requires a finite nonzero constant divisor.');
  });
}

function components(swizzle: string, width: number): number[] {
  const alphabet = /^[rgba]+$/u.test(swizzle) ? 'rgba' : 'xyzw';
  const result = Array.from({ length: swizzle.length }, (_, index) =>
    alphabet.indexOf(swizzle.charAt(index)),
  );
  if (
    result.length === 0 ||
    result.length > 4 ||
    result.some((index) => index < 0 || index >= width)
  )
    unsupported('Shader swizzle is outside its vector.');
  return result;
}

function withoutComments(source: string): string {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/\/\/[^\r\n]*/gu, '');
  if (stripped.includes('/*')) unsupported('Shader has an unterminated comment.');
  return stripped;
}

function inactiveFeatures(source: string): string {
  const stack: Array<{ parent: boolean; condition: boolean; alternative: boolean }> = [];
  let active = true;
  const output: string[] = [];
  for (const line of source.split(/\r?\n/u)) {
    const directive = /^\s*[#@](\w+)(?:\s+([\s\S]*?))?\s*$/u.exec(line);
    if (directive === null) {
      if (active) output.push(line);
      continue;
    }
    const [, command, argument] = directive;
    if (command === 'ifdef' || command === 'ifndef') {
      if (!['ANIMATED', 'MASKING'].includes(argument ?? ''))
        unsupported(`Shader feature ${argument ?? '(missing)'} has no supported binding.`);
      if (stack.length >= maxDepth) unsupported('Shader preprocessor nesting exceeds its budget.');
      const condition = command === 'ifndef';
      stack.push({ parent: active, condition, alternative: false });
      active = active && condition;
    } else if (command === 'else' && argument === undefined) {
      const branch = stack.at(-1);
      if (branch === undefined || branch.alternative) unsupported('Shader has an unmatched else.');
      branch.alternative = true;
      active = branch.parent && !branch.condition;
    } else if (command === 'endif' && argument === undefined) {
      const branch = stack.pop();
      if (branch === undefined) unsupported('Shader has an unmatched endif.');
      active = branch.parent;
    } else unsupported(`Shader directive ${command ?? '(missing)'} is not supported.`);
  }
  if (stack.length !== 0) unsupported('Shader has an unterminated conditional feature.');
  return output.join('\n');
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  const pattern =
    /\s+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fF]?|[A-Za-z_]\w*|[+*/-]=|[{}()[\],;.=+*/-]/guy;
  let offset = 0;
  while (offset < source.length) {
    pattern.lastIndex = offset;
    const token = pattern.exec(source)?.[0];
    if (token === undefined) unsupported('Shader contains unsupported expression syntax.');
    offset += token.length;
    if (token.trim().length === 0) continue;
    if (token.length > maxTokenLength) unsupported('Shader token length exceeds its budget.');
    tokens.push(token);
    if (tokens.length > maxTokens) unsupported('Shader token count exceeds its budget.');
  }
  return tokens;
}

class ColourInterpreter {
  private offset = 0;
  private depth = 0;
  private readonly variables = new Map<string, Value>();

  public constructor(
    private readonly tokens: readonly string[],
    private readonly inputName: string,
    uniforms: GuiShaderUniforms,
  ) {
    this.variables.set('Color', (uniforms.colour ?? [1, 1, 1, 1]).map(constant));
    this.variables.set('Time', [constant(uniforms.time)]);
    this.variables.set('AnimationTime', [constant(uniforms.animationTime)]);
  }

  private peek(): string | undefined {
    return this.tokens[this.offset];
  }

  private take(): string {
    const token = this.tokens[this.offset++];
    return token ?? unsupported('Shader expression ended unexpectedly.');
  }

  private require(token: string): void {
    if (this.take() !== token) unsupported(`Shader expected ${token}.`);
  }

  private identifier(): string {
    const token = this.take();
    return /^[A-Za-z_]\w*$/u.test(token) ? token : unsupported('Shader expected an identifier.');
  }

  private functionCall(name: string): Value {
    this.require('(');
    if (name === 'tex2D') {
      this.require('MapTexture');
      this.require(',');
      this.require(this.inputName);
      this.require('.');
      this.require('vTexCoord');
      this.require(')');
      return identity;
    }
    const args: Value[] = [];
    if (this.peek() !== ')') {
      for (;;) {
        args.push(this.expression());
        if (args.length > 4) unsupported('Shader call exceeds its argument budget.');
        if (this.peek() !== ',') break;
        this.take();
      }
    }
    this.require(')');
    const constructor = /^float([1-4])?$/u.exec(name);
    if (constructor !== null) {
      const width = Number(constructor[1] ?? 1);
      const channels = args.flat();
      if (channels.length === 1) return Array.from({ length: width }, () => channels[0]!);
      if (channels.length !== width) unsupported('Shader vector constructor has the wrong width.');
      return channels;
    }
    if (name === 'dot' && args.length === 2 && args[0]!.length === args[1]!.length) {
      const product = binary(args[0]!, args[1]!, '*');
      return [product.reduce((sum, channel) => binary([sum], [channel], '+')[0]!, constant(0))];
    }
    if (name === 'lerp' && args.length === 3)
      return binary(args[0]!, binary(binary(args[1]!, args[0]!, '-'), args[2]!, '*'), '+');
    if (['saturate', 'abs'].includes(name) && args.length === 1)
      return args[0]!.map((channel) => {
        if (!isConstant(channel)) unsupported(`${name} of sampled colour is nonlinear.`);
        return constant(
          name === 'abs' ? Math.abs(channel[4]) : Math.max(0, Math.min(1, channel[4])),
        );
      });
    if (
      ['min', 'max', 'pow'].includes(name) &&
      args.length === 2 &&
      args.every((arg) => arg.length === 1 && isConstant(arg[0]!))
    ) {
      const a = args[0]![0]![4];
      const b = args[1]![0]![4];
      return [
        checked([
          0,
          0,
          0,
          0,
          name === 'min' ? Math.min(a, b) : name === 'max' ? Math.max(a, b) : Math.pow(a, b),
        ]),
      ];
    }
    return unsupported(`Shader call ${name} is not a supported affine colour operation.`);
  }

  private primary(): Value {
    const token = this.take();
    let value: Value;
    if (token === '(') {
      value = this.expression();
      this.require(')');
    } else if (token === '-' || token === '+') {
      value = binary([constant(token === '-' ? -1 : 1)], this.expression(3), '*');
    } else if (/^(?:\d|\.)/u.test(token)) {
      value = [checked([0, 0, 0, 0, Number(token.replace(/[fF]$/u, ''))])];
    } else if (this.peek() === '(') {
      value = this.functionCall(token);
    } else {
      value = this.variables.get(token) ?? unsupported(`Shader value ${token} is unresolved.`);
    }
    while (this.peek() === '.') {
      this.take();
      value = components(this.identifier(), value.length).map((index) => value[index]!);
    }
    return value;
  }

  private expression(minimumPrecedence = 0): Value {
    this.depth += 1;
    if (this.depth > maxDepth) unsupported('Shader expression nesting exceeds its budget.');
    try {
      let value = this.primary();
      for (;;) {
        const operator = this.peek();
        const precedence =
          operator === '+' || operator === '-' ? 1 : operator === '*' || operator === '/' ? 2 : -1;
        if (precedence < minimumPrecedence) return value;
        this.take();
        value = binary(value, this.expression(precedence + 1), operator!);
      }
    } finally {
      this.depth -= 1;
    }
  }

  public run(): number[] {
    for (let statement = 0; statement < maxStatements; statement += 1) {
      const first = this.identifier();
      if (first === 'return') {
        const value = this.expression();
        this.require(';');
        if (value.length !== 4 || this.offset !== this.tokens.length)
          unsupported('Shader must finish with one four-channel colour return.');
        return value.flat();
      }
      const declaration = /^float([1-4])?$/u.exec(first);
      const name = declaration === null ? first : this.identifier();
      if (['Color', 'Time', 'AnimationTime'].includes(name))
        unsupported('Shader cannot assign to a uniform.');
      if (declaration !== null && this.variables.has(name))
        unsupported('Shader redeclares a value.');
      const existing = this.variables.get(name);
      let swizzle: number[] | undefined;
      if (this.peek() === '.') {
        this.take();
        swizzle = components(this.identifier(), existing?.length ?? 0);
        if (new Set(swizzle).size !== swizzle.length)
          unsupported('Shader assignment repeats a swizzle component.');
      }
      const operator = this.take();
      if (!['=', '+=', '-=', '*=', '/='].includes(operator))
        unsupported('Shader statement is not an assignment.');
      const width =
        declaration === null ? (swizzle?.length ?? existing?.length) : Number(declaration[1] ?? 1);
      if (width === undefined) unsupported(`Shader assignment to ${name} is undeclared.`);
      let value = this.expression();
      this.require(';');
      if (value.length === 1) value = Array.from({ length: width }, () => value[0]!);
      if (value.length !== width) unsupported('Shader assignment changes vector width.');
      if (operator !== '=') {
        if (existing === undefined || declaration !== null)
          unsupported('Shader compound assignment has no prior value.');
        value = binary(
          swizzle === undefined ? existing : swizzle.map((index) => existing[index]!),
          value,
          operator[0]!,
        );
      }
      if (swizzle === undefined) this.variables.set(name, value);
      else {
        const replaced = [...existing!];
        swizzle.forEach((index, component) => {
          replaced[index] = value[component]!;
        });
        this.variables.set(name, replaced);
      }
    }
    return unsupported('Shader statement count exceeds its budget.');
  }
}

function mainCodes(source: string): Map<string, string> {
  const codes = new Map<string, string>();
  for (const match of source.matchAll(/\bMainCode\s+(\w+)\s*\[\[([\s\S]*?)\]\]/gu)) {
    if (codes.has(match[1]!)) unsupported('Shader has duplicate named programs.');
    codes.set(match[1]!, match[2]!);
  }
  return codes;
}

function assertNativeVertex(source: string): void {
  const program = inactiveFeatures(source).replace(/\s+/gu, '');
  const match = /^VS_OUTPUTmain\((?:const)?VS_INPUT(\w+)\)\{VS_OUTPUT(\w+);([\s\S]*)\}$/u.exec(
    program,
  );
  if (match === null)
    unsupported('Shader vertex program is not the supported native sprite transform.');
  const [, input, output, body] = match;
  const prefix = `${output}.vPosition=mul(WorldViewProjectionMatrix,float4(${input}.vPosition.xyz,1));${output}.vTexCoord=${input}.vTexCoord;`;
  const endings = ['', `${output}.vTexCoord+=Offset;`, `${output}.vTexCoord.x+=vXOffset;`];
  if (!endings.some((offset) => body === `${prefix}${offset}return${output};`))
    unsupported(
      'Shader changes sprite geometry or texture coordinates beyond native atlas offsets.',
    );
}

function fields(source: string): Map<string, string> {
  const result = new Map<string, string>();
  const remainder = source.replace(
    /\b(\w+)\s*=\s*(?:"([^"\r\n]*)"|([A-Za-z_][A-Za-z0-9_]*|[+-]?(?:\d+(?:\.\d*)?|\.\d+)))/gu,
    (_match, name: string, quoted: string | undefined, scalar: string | undefined) => {
      if (result.has(name)) unsupported('Shader render state has a duplicate field.');
      result.set(name, quoted ?? scalar!);
      return '';
    },
  );
  if (remainder.trim().length > 0) unsupported('Shader render state contains unsupported syntax.');
  return result;
}

function textureFiltering(source: string): GuiSpriteShader['textureFiltering'] {
  const samplers = [...source.matchAll(/\bMapTexture\s*=\s*\{([^{}]*)\}/gu)];
  if (samplers.length !== 1) unsupported('Shader must bind one primary MapTexture sampler.');
  const sampler = fields(samplers[0]![1]!);
  if (
    sampler.get('Index') !== '0' ||
    sampler.get('AddressU') !== 'Clamp' ||
    sampler.get('AddressV') !== 'Clamp' ||
    sampler.get('MipFilter') !== 'None'
  )
    unsupported(
      'Shader sampler requires primary texture slot zero, clamp addressing and no mip filtering.',
    );
  if (
    [...sampler.keys()].some(
      (key) =>
        ![
          'Index',
          'MagFilter',
          'MinFilter',
          'MipFilter',
          'AddressU',
          'AddressV',
          'MipMapLodBias',
        ].includes(key),
    )
  )
    unsupported('Shader sampler has unsupported fields.');
  const mode = (key: string): 'linear' | 'nearest' =>
    sampler.get(key) === 'Linear'
      ? 'linear'
      : sampler.get(key) === 'Point'
        ? 'nearest'
        : unsupported(`Shader ${key} is not a supported texture filter.`);
  return { magnification: mode('MagFilter'), minification: mode('MinFilter') };
}

function assertStraightAlphaBlend(source: string): void {
  const blends = [...source.matchAll(/\bBlendState\s+\w+\s*\{([^{}]*)\}/gu)];
  const blendFields = blends.length === 1 ? fields(blends[0]![1]!) : new Map<string, string>();
  if (
    blends.length !== 1 ||
    blendFields.get('BlendEnable') !== 'yes' ||
    blendFields.get('SourceBlend')?.toLowerCase() !== 'src_alpha' ||
    blendFields.get('DestBlend')?.toLowerCase() !== 'inv_src_alpha' ||
    (blendFields.has('AlphaTest') && blendFields.get('AlphaTest') !== 'no') ||
    (blendFields.has('BlendOp') && blendFields.get('BlendOp')?.toLowerCase() !== 'add') ||
    [...blendFields.keys()].some(
      (key) => !['BlendEnable', 'SourceBlend', 'DestBlend', 'AlphaTest', 'BlendOp'].includes(key),
    )
  )
    unsupported('Shader does not use supported straight-alpha sprite blending.');
}

/** Recognize the native two-source threshold operation, never execute arbitrary shader code. */
export function compileGuiProgressEffect(
  source: string,
  provenance: { path: string; sha256: string },
  effect: 'Color' | 'Texture',
): GuiProgressShaderResult {
  try {
    if (Buffer.byteLength(source, 'utf8') > GUI_SHADER_MAX_BYTES)
      unsupported('Shader source exceeds its byte budget.');
    const clean = withoutComments(source);
    if (/^\s*[#@]/mu.test(clean) || /\bIncludes\s*=\s*\{\s*[^\s}]/u.test(clean))
      unsupported('Progress shader has unbound includes or feature directives.');
    const effects = [...clean.matchAll(/\bEffect\s+(\w+)\s*\{([^{}]*)\}/gu)].filter(
      (match) => match[1] === effect,
    );
    if (effects.length !== 1) unsupported(`Shader must define exactly one ${effect} effect.`);
    const effectFields = fields(effects[0]![2]!);
    const pixel = effectFields.get('PixelShader');
    const vertex = effectFields.get('VertexShader');
    if (effectFields.size !== 2 || pixel === undefined || vertex === undefined)
      unsupported('Progress shader effect has unsupported render-state overrides.');
    const programs = mainCodes(clean);
    const vertexSource = programs.get(vertex)?.replace(/\s+/gu, '');
    const vertexProgram =
      vertexSource === undefined
        ? null
        : /^VS_OUTPUTmain\((?:const)?VS_INPUT(\w+)\)\{VS_OUTPUT(\w+);([\s\S]*)\}$/u.exec(
            vertexSource,
          );
    if (vertexProgram === null) unsupported('Progress vertex program is not a native transform.');
    const [, input, output, body] = vertexProgram;
    if (
      body !==
      `${output}.vPosition=mul(WorldViewProjectionMatrix,${input}.vPosition);${output}.vTexCoord0=${input}.vTexCoord;${output}.vTexCoord0.y=-${output}.vTexCoord0.y;return${output};`
    )
      unsupported('Progress shader changes native geometry or texture coordinates.');
    const pixelSource = programs.get(pixel);
    const program =
      pixelSource === undefined
        ? null
        : /^\s*float4\s+main\(\s*(?:const\s+)?VS_OUTPUT\s+(\w+)\s*\)\s*:\s*PDX_COLOR\s*\{([\s\S]*)\}\s*$/u.exec(
            pixelSource,
          );
    if (program === null) unsupported('Progress shader pixel program is missing or unsupported.');
    const variable = program[1]!;
    const first =
      effect === 'Color' ? 'vFirstColor' : `tex2D(TextureOne,${variable}.vTexCoord0.xy)`;
    const second =
      effect === 'Color' ? 'vSecondColor' : `tex2D(TextureTwo,${variable}.vTexCoord0.xy)`;
    const pixelBody = program[2]!.replace(/\s+/gu, '');
    if (
      pixelBody !== `if(${variable}.vTexCoord0.x<=CurrentState)return${first};elsereturn${second};`
    )
      unsupported('Progress pixel program is not a supported two-source threshold operation.');
    assertStraightAlphaBlend(clean);
    let filtering: GuiSpriteShader['textureFiltering'] | undefined;
    if (effect === 'Texture') {
      const modes = ['TextureOne', 'TextureTwo'].map((name, index) => {
        const declarations = [
          ...clean.matchAll(new RegExp(`\\b${name}\\s*=\\s*\\{([^{}]*)\\}`, 'gu')),
        ];
        if (declarations.length !== 1)
          unsupported(`Progress shader must bind one ${name} sampler.`);
        const sampler = fields(declarations[0]![1]!);
        if (
          sampler.get('Index') !== String(index) ||
          sampler.get('MipFilter') !== 'None' ||
          sampler.get('AddressU') !== 'Wrap' ||
          sampler.get('AddressV') !== 'Wrap' ||
          [...sampler.keys()].some(
            (key) =>
              !['Index', 'MagFilter', 'MinFilter', 'MipFilter', 'AddressU', 'AddressV'].includes(
                key,
              ),
          )
        )
          unsupported(
            'Progress samplers require their declared slots, wrap addressing and no mip filtering.',
          );
        const mode = (key: string): 'nearest' | 'linear' =>
          sampler.get(key) === 'Point'
            ? 'nearest'
            : sampler.get(key) === 'Linear'
              ? 'linear'
              : unsupported(`Unsupported progress ${key}.`);
        return { magnification: mode('MagFilter'), minification: mode('MinFilter') };
      });
      if (
        modes[0]!.magnification !== modes[1]!.magnification ||
        modes[0]!.minification !== modes[1]!.minification
      )
        unsupported('Progress textures require matching filtering modes.');
      filtering = modes[0]!;
    }
    return {
      supported: true,
      shader: {
        sourcePath: provenance.path,
        sourceHash: provenance.sha256,
        effect,
        entryPoint: pixel,
        composition: 'threshold',
        ...(filtering === undefined ? {} : { textureFiltering: filtering }),
      },
    };
  } catch (error) {
    if (!(error instanceof UnsupportedShader)) throw error;
    return { supported: false, reason: error.message };
  }
}

export function compileGuiShaderEffect(
  source: string,
  provenance: { path: string; sha256: string },
  effect: GuiShaderEffect,
  uniforms: GuiShaderUniforms,
): GuiShaderResult {
  try {
    if (Buffer.byteLength(source, 'utf8') > GUI_SHADER_MAX_BYTES)
      unsupported('Shader source exceeds its byte budget.');
    if (
      [uniforms.time, uniforms.animationTime, ...(uniforms.colour ?? [])].some(
        (value) => !Number.isFinite(value) || Math.abs(value) > maxCoefficient,
      )
    )
      unsupported('Shader uniforms must be finite and within their coefficient budget.');
    const clean = withoutComments(source);
    if (/^\s*[#@](?:define|undef|include|if|elif|pragma)\b/mu.test(clean))
      unsupported('Shader contains unbound preprocessor definitions or expressions.');
    const effects = [...clean.matchAll(/\bEffect\s+(\w+)\s*\{([^{}]*)\}/gu)].filter(
      (match) => match[1] === effect,
    );
    if (effects.length !== 1) unsupported(`Shader must define exactly one ${effect} effect.`);
    const effectFields = fields(effects[0]![2]!);
    const pixel = effectFields.get('PixelShader');
    const vertex = effectFields.get('VertexShader');
    if (effectFields.size !== 2 || pixel === undefined || vertex === undefined)
      unsupported('Shader effect has unsupported render-state overrides.');
    const programs = mainCodes(clean);
    const pixelSource = programs.get(pixel);
    const vertexSource = programs.get(vertex);
    if (pixelSource === undefined || vertexSource === undefined)
      unsupported('Shader effect entry point is missing.');
    assertNativeVertex(vertexSource);
    assertStraightAlphaBlend(clean);
    const program =
      /^\s*float4\s+main\(\s*(?:const\s+)?VS_OUTPUT\s+(\w+)\s*\)\s*:\s*PDX_COLOR\s*\{([^{}]*)\}\s*$/u.exec(
        inactiveFeatures(pixelSource),
      );
    if (program === null) unsupported('Shader pixel program has unsupported control flow.');
    const colourMatrix = new ColourInterpreter(tokenize(program[2]!), program[1]!, uniforms).run();
    const filtering = textureFiltering(clean);
    return {
      supported: true,
      shader: {
        sourcePath: provenance.path,
        sourceHash: provenance.sha256,
        effect,
        entryPoint: pixel,
        textureFiltering: filtering,
        colourMatrix,
      },
    };
  } catch (error) {
    if (!(error instanceof UnsupportedShader)) throw error;
    return { supported: false, reason: error.message };
  }
}
