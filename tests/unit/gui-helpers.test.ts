import { describe, expect, it, vi } from 'vitest';
import {
  assignments,
  childBlocks,
  firstScalar,
  parseClausewitz,
  type AssignmentNode,
  type BlockNode,
} from '../../src/hoi4_agent_tools/core/source/index.js';
import { emptyServiceResult } from '../../src/hoi4_agent_tools/core/result.js';
import type {
  TransactionManager,
  TransactionManifest,
} from '../../src/hoi4_agent_tools/core/transactions.js';
import {
  assertGuiHelperGeneratedSourceBytes,
  compileGuiHelpers,
  GUI_HELPER_MAX_GENERATED_SOURCE_WORK,
  planGuiHelperCompilation,
  type GuiHelperNode,
} from '../../src/hoi4_agent_tools/gui/helpers.js';
import { guiPlanOutputSchema } from '../../src/hoi4_agent_tools/mcp/tools/gui.js';

function allAssignments(block: BlockNode): AssignmentNode[] {
  const output: AssignmentNode[] = [];
  const pending = [block];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const assignment of assignments(current)) {
      output.push(assignment);
      if (assignment.value.type === 'block') pending.push(assignment.value);
    }
  }
  return output;
}

function namedBlock(source: string, name: string): { type: string; block: BlockNode } {
  const document = parseClausewitz(Buffer.from(source), 'generated:test.gui');
  expect(document.diagnostics).toEqual([]);
  for (const assignment of allAssignments(document.root)) {
    if (assignment.value.type === 'block' && firstScalar(assignment.value, 'name')?.value === name)
      return { type: assignment.key.value, block: assignment.value };
  }
  throw new Error(`Missing generated GUI block ${name}`);
}

function numberField(block: BlockNode, key: string): number {
  const value = firstScalar(block, key)?.value;
  if (value === undefined) throw new Error(`Missing scalar ${key}`);
  return Number(value);
}

function stringField(block: BlockNode, key: string): string {
  const value = firstScalar(block, key)?.value;
  if (value === undefined) throw new Error(`Missing scalar ${key}`);
  return value;
}

function position(source: string, name: string): { x: number; y: number } {
  const block = namedBlock(source, name).block;
  const positionBlock = childBlocks(block, 'position')[0];
  if (positionBlock === undefined) throw new Error(`Missing position for ${name}`);
  return { x: numberField(positionBlock, 'x'), y: numberField(positionBlock, 'y') };
}

function element(id: string, width: number, height: number): GuiHelperNode {
  return { id, kind: 'element', width, height, children: [] };
}

describe('GUI helper templates and state variants', () => {
  const reusable = {
    version: 1,
    templates: [
      {
        id: 'status_card',
        root: {
          id: 'card_root',
          kind: 'card',
          name: 'status_card',
          width: 120,
          height: 48,
          sprite: 'GFX_card_background',
          children: [
            {
              id: 'label',
              kind: 'element',
              elementType: 'buttonType',
              name: 'status_label',
              width: 100,
              height: 20,
              sprite: 'GFX_idle',
              text: 'IDLE_TEXT',
              state: 'selected',
              stateVariants: [
                {
                  state: 'selected',
                  frame: 7,
                  sprite: 'GFX_selected',
                  text: 'SELECTED_TEXT',
                  attributes: { pdx_tooltip: 'SELECTED_TOOLTIP' },
                },
              ],
              children: [],
            },
          ],
        },
      },
    ],
    root: {
      id: 'root',
      kind: 'row',
      gap: 8,
      children: [
        { id: 'first', kind: 'template', templateId: 'status_card', children: [] },
        { id: 'second', kind: 'template', templateId: 'status_card', children: [] },
      ],
    },
  };

  it('expands reusable templates with deterministic instance names and concrete selected states', () => {
    const first = compileGuiHelpers(reusable);
    const second = compileGuiHelpers(structuredClone(reusable));

    expect(second.source).toBe(first.source);
    expect(first).toMatchObject({ nodeCount: 5, templateInstanceCount: 2, rawEscapeCount: 0 });
    for (const name of [
      'first__status_card',
      'first__status_label',
      'second__status_card',
      'second__status_label',
    ])
      expect(first.source).toContain(`name = "${name}"`);

    const firstLabel = namedBlock(first.source, 'first__status_label');
    expect(firstLabel.type).toBe('buttonType');
    expect(stringField(firstLabel.block, 'spriteType')).toBe('GFX_selected');
    expect(stringField(firstLabel.block, 'buttonText')).toBe('SELECTED_TEXT');
    expect(numberField(firstLabel.block, 'frame')).toBe(7);
    expect(stringField(firstLabel.block, 'pdx_tooltip')).toBe('SELECTED_TOOLTIP');
    expect(first.source).not.toContain('GFX_idle');
    expect(first.source).not.toContain('IDLE_TEXT');
    expect(first.source).not.toContain('helper preview state');

    const firstCard = namedBlock(first.source, 'first__status_card').block;
    const background = childBlocks(firstCard, 'background')[0];
    expect(background).toBeDefined();
    expect(stringField(background!, 'spriteType')).toBe('GFX_card_background');
    expect(position(first.source, 'first__status_card')).toEqual({ x: 0, y: 0 });
    expect(position(first.source, 'second__status_card')).toEqual({ x: 128, y: 0 });
  });

  it('preserves template evidence in transaction planning', async () => {
    const plan = vi.fn((input: Parameters<TransactionManager['plan']>[0]) =>
      Promise.resolve({
        transactionId: 'txn_template',
        planHash: 'hash',
        operationKind: input.operationKind,
      } as unknown as TransactionManifest),
    );
    const result = await planGuiHelperCompilation({ plan } as unknown as TransactionManager, {
      workspaceId: 'fixture',
      relativePath: 'interface/templates.gui',
      helper: reusable,
    });

    expect(plan).toHaveBeenCalledOnce();
    expect(plan.mock.calls[0]?.[0]).toMatchObject({
      operationKind: 'gui-helper-compilation',
      operations: [
        {
          data: { nodeCount: 5, templateInstanceCount: 2, rawEscapeCount: 0 },
        },
      ],
    });
    expect(result.compilation.source).toContain('first__status_card');
  });

  it('exposes template-instance evidence in the MCP GUI plan output contract', () => {
    const output = emptyServiceResult('fixture', {
      execution: 'applied' as const,
      mode: 'helpers' as const,
      nodeCount: 5,
      templateInstanceCount: 2,
      rawEscapeCount: 0,
      fileCount: 1,
      artifactCount: 0,
    });
    expect(guiPlanOutputSchema.parse(output).data).toMatchObject({ templateInstanceCount: 2 });
  });
});

describe('GUI helper layout and widget semantics', () => {
  const helper = {
    version: 1,
    root: {
      id: 'root_column',
      kind: 'column',
      gap: 2,
      children: [
        {
          id: 'screen_anchor',
          kind: 'anchor',
          x: 12,
          y: 14,
          orientation: 'LOWER_RIGHT',
          origo: 'center',
          children: [
            {
              id: 'anchored_icon',
              kind: 'element',
              elementType: 'iconType',
              sprite: 'GFX_anchor',
              width: 16,
              height: 16,
              children: [],
            },
          ],
        },
        {
          id: 'row',
          kind: 'row',
          gap: 5,
          children: [element('row_a', 10, 10), element('row_b', 20, 10)],
        },
        {
          id: 'column',
          kind: 'column',
          gap: 4,
          children: [element('column_a', 10, 5), element('column_b', 10, 7)],
        },
        {
          id: 'stack',
          kind: 'stack',
          padding: 2,
          children: [
            { ...element('stack_a', 10, 5), x: 1, y: 2 },
            { ...element('stack_b', 8, 6), x: 3, y: 4 },
          ],
        },
        {
          id: 'variable_grid',
          kind: 'grid',
          width: 100,
          columns: 2,
          gap: 3,
          padding: 1,
          children: [
            element('grid_a', 10, 10),
            element('grid_b', 10, 30),
            element('grid_c', 10, 5),
            element('grid_d', 10, 7),
          ],
        },
        {
          id: 'card',
          kind: 'card',
          width: 80,
          height: 40,
          sprite: 'GFX_card',
          children: [element('card_child', 10, 10)],
        },
        {
          id: 'tabs',
          kind: 'tabs',
          gap: 6,
          children: [
            {
              ...element('tab_a', 20, 10),
              elementType: 'buttonType',
              sprite: 'GFX_tab',
              text: 'TAB_A',
              font: 'hoi_16mbs',
              state: 'normal',
            },
            {
              ...element('tab_b', 20, 10),
              elementType: 'buttonType',
              sprite: 'GFX_tab',
              text: 'TAB_B',
              font: 'hoi_16mbs',
              state: 'selected',
              stateVariants: [
                {
                  state: 'selected',
                  frame: 3,
                  sprite: 'GFX_tab_selected',
                  text: 'TAB_SELECTED',
                },
              ],
            },
          ],
        },
        {
          id: 'scroll_list',
          kind: 'scroll-list',
          flow: 'horizontal',
          gap: 7,
          width: 80,
          height: 20,
          backgroundSprite: 'GFX_transparent_scroll_background',
          scrollbar: 'bottom_horizontal_slider',
          children: [
            {
              id: 'scroll_entry',
              kind: 'row',
              width: 25,
              height: 10,
              gap: 2,
              children: [element('scroll_a', 10, 10), element('scroll_b', 13, 10)],
            },
          ],
        },
        {
          id: 'target_row',
          kind: 'target-row',
          gap: 2,
          children: [element('target_a', 11, 5), element('target_b', 12, 5)],
        },
        {
          id: 'readiness_meter',
          kind: 'meter',
          width: 80,
          height: 8,
          minValue: 1,
          maxValue: 9,
          value: 4,
          frames: 9,
          sprite: 'GFX_readiness_meter',
          children: [],
        },
        {
          id: 'status_panel',
          kind: 'status-panel',
          gap: 3,
          children: [
            element('status_a', 10, 4),
            {
              id: 'status_b',
              kind: 'element',
              elementType: 'instantTextBoxType',
              width: 40,
              height: 6,
              text: 'STATUS_B',
              font: 'hoi_16mbs',
              children: [],
            },
          ],
        },
        {
          id: 'confirmation_modal',
          kind: 'modal',
          width: 100,
          height: 80,
          sprite: 'GFX_modal',
          children: [element('modal_child', 10, 10)],
        },
        {
          id: 'overlay',
          kind: 'overlay',
          width: 50,
          height: 50,
          children: [element('overlay_a', 10, 10), { ...element('overlay_b', 10, 10), x: 4, y: 5 }],
        },
        {
          id: 'raw_escape',
          kind: 'raw',
          raw: 'iconType = { name = "advanced_raw" position = { x = 7 y = 9 } size = { width = 2 height = 3 } }',
          children: [],
        },
      ],
    },
  };

  it('gives every helper kind concrete deterministic layout or source behavior', () => {
    const result = compileGuiHelpers(helper);

    const anchor = namedBlock(result.source, 'screen_anchor');
    expect(anchor.type).toBe('containerWindowType');
    expect(position(result.source, 'screen_anchor')).toEqual({ x: 12, y: 14 });
    expect(stringField(anchor.block, 'orientation')).toBe('lower_right');
    expect(stringField(anchor.block, 'origo')).toBe('center');
    const anchoredIcon = namedBlock(result.source, 'anchored_icon');
    expect(anchoredIcon.type).toBe('iconType');
    expect(stringField(anchoredIcon.block, 'spriteType')).toBe('GFX_anchor');
    expect(stringField(anchoredIcon.block, 'orientation')).toBe('upper_left');
    expect(childBlocks(anchoredIcon.block, 'size')).toHaveLength(0);

    expect(position(result.source, 'row_a')).toEqual({ x: 0, y: 0 });
    expect(position(result.source, 'row_b')).toEqual({ x: 15, y: 0 });
    expect(position(result.source, 'column_a')).toEqual({ x: 0, y: 0 });
    expect(position(result.source, 'column_b')).toEqual({ x: 0, y: 9 });
    expect(position(result.source, 'stack_a')).toEqual({ x: 3, y: 4 });
    expect(position(result.source, 'stack_b')).toEqual({ x: 5, y: 6 });

    expect(position(result.source, 'grid_a')).toEqual({ x: 1, y: 1 });
    expect(position(result.source, 'grid_b')).toEqual({ x: 51.5, y: 1 });
    expect(position(result.source, 'grid_c')).toEqual({ x: 1, y: 34 });
    expect(position(result.source, 'grid_d')).toEqual({ x: 51.5, y: 34 });

    const cardBackground = childBlocks(namedBlock(result.source, 'card').block, 'background')[0];
    expect(stringField(cardBackground!, 'spriteType')).toBe('GFX_card');
    expect(position(result.source, 'tab_a')).toEqual({ x: 0, y: 0 });
    expect(position(result.source, 'tab_b')).toEqual({ x: 26, y: 0 });
    expect(firstScalar(namedBlock(result.source, 'tab_a').block, 'frame')).toBeUndefined();
    expect(stringField(namedBlock(result.source, 'tab_a').block, 'buttonText')).toBe('TAB_A');
    expect(stringField(namedBlock(result.source, 'tab_a').block, 'buttonFont')).toBe('hoi_16mbs');
    expect(childBlocks(namedBlock(result.source, 'tab_a').block, 'size')).toHaveLength(0);
    expect(numberField(namedBlock(result.source, 'tab_b').block, 'frame')).toBe(3);
    expect(stringField(namedBlock(result.source, 'tab_b').block, 'spriteType')).toBe(
      'GFX_tab_selected',
    );

    const scroll = namedBlock(result.source, 'scroll_list');
    expect(scroll.type).toBe('containerWindowType');
    expect(stringField(scroll.block, 'horizontalScrollbar')).toBe('bottom_horizontal_slider');
    const scrollGrid = childBlocks(scroll.block, 'gridBoxType')[0];
    expect(scrollGrid).toBeDefined();
    expect(stringField(scrollGrid!, 'name')).toBe('scroll_list__grid');
    expect(stringField(scrollGrid!, 'orientation')).toBe('upper_left');
    const slotSize = childBlocks(scrollGrid!, 'slotsize')[0];
    expect(numberField(slotSize!, 'width')).toBe(32);
    expect(numberField(slotSize!, 'height')).toBe(10);
    expect(numberField(scrollGrid!, 'max_slots_vertical')).toBe(1);
    expect(namedBlock(result.source, 'scroll_list__entry').type).toBe('containerWindowType');
    expect(position(result.source, 'scroll_a')).toEqual({ x: 0, y: 0 });
    expect(position(result.source, 'scroll_b')).toEqual({ x: 12, y: 0 });
    expect(position(result.source, 'target_b')).toEqual({ x: 13, y: 0 });

    const meter = namedBlock(result.source, 'readiness_meter');
    expect(meter.type).toBe('containerWindowType');
    const meterFill = namedBlock(result.source, 'readiness_meter__fill');
    expect(meterFill.type).toBe('iconType');
    expect(stringField(meterFill.block, 'spriteType')).toBe('GFX_readiness_meter');
    expect(numberField(meterFill.block, 'frame')).toBe(4);
    expect(result.source).not.toContain('progressbarType = {');
    expect(result.source).not.toMatch(/\b(?:minValue|maxValue|startValue)\s*=/u);
    expect(position(result.source, 'status_b')).toEqual({ x: 0, y: 7 });
    const statusText = namedBlock(result.source, 'status_b').block;
    expect(numberField(statusText, 'maxWidth')).toBe(40);
    expect(numberField(statusText, 'maxHeight')).toBe(6);
    expect(childBlocks(statusText, 'size')).toHaveLength(0);

    const modal = namedBlock(result.source, 'confirmation_modal');
    expect(modal.type).toBe('windowType');
    expect(stringField(modal.block, 'orientation')).toBe('center');
    expect(stringField(modal.block, 'origo')).toBe('center');
    expect(stringField(namedBlock(result.source, 'modal_child').block, 'orientation')).toBe(
      'upper_left',
    );
    expect(stringField(childBlocks(modal.block, 'background')[0]!, 'spriteType')).toBe('GFX_modal');

    const overlay = namedBlock(result.source, 'overlay').block;
    expect(stringField(overlay, 'clipping')).toBe('no');
    expect(position(result.source, 'overlay_a')).toEqual({ x: 0, y: 0 });
    expect(position(result.source, 'overlay_b')).toEqual({ x: 4, y: 5 });
    expect(position(result.source, 'advanced_raw')).toEqual({ x: 7, y: 9 });
    expect(result.rawEscapeCount).toBe(1);
  });

  it('emits vertical scroll flow with an independent entry container handoff', () => {
    const result = compileGuiHelpers({
      version: 1,
      root: {
        id: 'scroll_root',
        kind: 'column',
        children: [
          {
            id: 'vertical_scroll',
            kind: 'scroll-list',
            flow: 'vertical',
            gap: 4,
            width: 60,
            height: 90,
            backgroundSprite: 'GFX_transparent_scroll_background',
            scrollbar: 'right_vertical_slider_intel',
            children: [
              {
                id: 'vertical_entry',
                kind: 'column',
                width: 20,
                height: 10,
                children: [element('vertical_entry_child', 20, 10)],
              },
            ],
          },
        ],
      },
    });

    const scroll = namedBlock(result.source, 'vertical_scroll').block;
    expect(stringField(scroll, 'verticalScrollbar')).toBe('right_vertical_slider_intel');
    const grid = childBlocks(scroll, 'gridBoxType')[0]!;
    const slotSize = childBlocks(grid, 'slotsize')[0]!;
    expect(numberField(slotSize, 'width')).toBe(20);
    expect(numberField(slotSize, 'height')).toBe(14);
    expect(numberField(grid, 'max_slots_horizontal')).toBe(1);
    expect(namedBlock(result.source, 'vertical_scroll__entry').type).toBe('containerWindowType');
    expect(result.source).not.toContain('listboxType = {');
  });
});

describe('GUI helper refusal and expansion budgets', () => {
  const templateRef = (id: string, templateId: string): GuiHelperNode => ({
    id,
    kind: 'template',
    templateId,
    children: [],
  });

  it.each([
    {
      code: 'GUI_HELPER_TEMPLATE_MISSING',
      input: { version: 1, root: templateRef('missing', 'absent') },
    },
    {
      code: 'GUI_HELPER_TEMPLATE_DUPLICATE',
      input: {
        version: 1,
        templates: [
          { id: 'same', root: element('one', 1, 1) },
          { id: 'same', root: element('two', 1, 1) },
        ],
        root: element('root', 1, 1),
      },
    },
    {
      code: 'GUI_HELPER_DUPLICATE_ID',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [element('duplicate', 1, 1), element('duplicate', 1, 1)],
        },
      },
    },
    {
      code: 'GUI_HELPER_ANCHOR_POINT_INVALID',
      input: {
        version: 1,
        root: { id: 'anchor', kind: 'anchor', orientation: 'somewhere', children: [] },
      },
    },
    {
      code: 'GUI_HELPER_METER_RANGE_INVALID',
      input: {
        version: 1,
        root: {
          id: 'meter',
          kind: 'meter',
          minValue: 10,
          maxValue: 5,
          value: 8,
          children: [],
        },
      },
    },
    {
      code: 'GUI_HELPER_STATE_VARIANT_MISSING',
      input: {
        version: 1,
        root: { ...element('state', 1, 1), state: 'bespoke' },
      },
    },
    {
      code: 'GUI_HELPER_STATE_VARIANT_MISSING',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [
            {
              ...element('selected_icon', 16, 16),
              elementType: 'iconType',
              sprite: 'GFX_icon',
              state: 'selected',
            },
          ],
        },
      },
    },
    {
      code: 'GUI_HELPER_DUPLICATE_NAME',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [
            { ...element('first_id', 1, 1), name: 'same_name' },
            { ...element('second_id', 1, 1), name: 'same_name' },
          ],
        },
      },
    },
    {
      code: 'GUI_HELPER_ELEMENT_FIELDS_AMBIGUOUS',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [{ ...element('ambiguous', 10, 10), sprite: 'GFX_icon', text: 'NOT_A_BUTTON' }],
        },
      },
    },
    {
      code: 'GUI_HELPER_ICON_TEXT_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [
            {
              ...element('invalid_icon', 10, 10),
              elementType: 'iconType',
              sprite: 'GFX_icon',
              text: 'INVALID',
            },
          ],
        },
      },
    },
    {
      code: 'GUI_HELPER_METER_FIELDS_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'invalid_meter_text',
          kind: 'meter',
          width: 80,
          height: 8,
          minValue: 0,
          maxValue: 10,
          value: 5,
          frames: 11,
          sprite: 'GFX_meter',
          text: 'IGNORED_BEFORE_HARDENING',
          children: [],
        },
      },
    },
    {
      code: 'GUI_HELPER_LEAF_CHILDREN_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [
            {
              ...element('icon_parent', 10, 10),
              elementType: 'iconType',
              sprite: 'GFX_icon',
              children: [element('invalid_child', 1, 1)],
            },
          ],
        },
      },
    },
    {
      code: 'GUI_HELPER_ROOT_INVALID',
      input: {
        version: 1,
        root: {
          ...element('root_icon', 10, 10),
          elementType: 'iconType',
          sprite: 'GFX_icon',
        },
      },
    },
    {
      code: 'GUI_HELPER_FIELD_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'row_with_scrollbar',
          kind: 'row',
          scrollbar: 'right_vertical_slider_intel',
          children: [],
        },
      },
    },
    {
      code: 'GUI_HELPER_CONTROLLED_ATTRIBUTE',
      input: {
        version: 1,
        root: {
          id: 'controlled_attribute',
          kind: 'row',
          attributes: { Name: 'duplicate_name' },
          children: [],
        },
      },
    },
    {
      code: 'GUI_HELPER_SCROLL_ENTRY_INVALID',
      input: {
        version: 1,
        root: {
          id: 'raw_entry_scroll',
          kind: 'scroll-list',
          width: 100,
          height: 100,
          backgroundSprite: 'GFX_transparent_scroll_background',
          scrollbar: 'right_vertical_slider_intel',
          children: [
            {
              id: 'raw_entry',
              kind: 'raw',
              raw: 'containerWindowType = { name = "not_the_handoff_name" }',
              children: [],
            },
          ],
        },
      },
    },
    {
      code: 'GUI_HELPER_ATTRIBUTE_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [
            {
              ...element('icon_with_scrollbar', 10, 10),
              elementType: 'iconType',
              sprite: 'GFX_icon',
              attributes: { verticalScrollbar: 'right_vertical_slider_intel' },
            },
          ],
        },
      },
    },
    ...(['checkboxType', 'guiButtonType', 'textBoxType'] as const).map((elementType) => ({
      code: 'GUI_HELPER_ELEMENT_TYPE_UNSUPPORTED',
      input: {
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          children: [{ ...element(`unsupported_${elementType}`, 10, 10), elementType }],
        },
      },
    })),
  ])('refuses $code', ({ code, input }) => {
    expect(() => compileGuiHelpers(input)).toThrowError(expect.objectContaining({ code }));
  });

  it('refuses template reference cycles even when the cycle is not used by the root', () => {
    const input = {
      version: 1,
      templates: [
        { id: 'a', root: templateRef('use_b', 'b') },
        { id: 'b', root: templateRef('use_a', 'a') },
      ],
      root: element('root', 1, 1),
    };
    expect(() => compileGuiHelpers(input)).toThrowError(
      expect.objectContaining({ code: 'GUI_HELPER_TEMPLATE_CYCLE' }),
    );
  });

  it('blocks multiplicative template expansion before materialising an unbounded tree', () => {
    const templates: Array<{ id: string; root: GuiHelperNode }> = [
      { id: 'level_0', root: element('leaf', 1, 1) },
    ];
    for (let level = 1; level <= 14; level += 1) {
      templates.push({
        id: `level_${level}`,
        root: {
          id: `pair_${level}`,
          kind: 'row',
          children: [
            templateRef(`left_${level}`, `level_${level - 1}`),
            templateRef(`right_${level}`, `level_${level - 1}`),
          ],
        },
      });
    }
    expect(() =>
      compileGuiHelpers({
        version: 1,
        templates,
        root: templateRef('expanded', 'level_14'),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'GUI_HELPER_NODE_BUDGET_BLOCKED',
        details: expect.objectContaining({ stage: 'expanded' }),
      }),
    );
  });

  it('blocks template-reference depth independently of source-tree depth', () => {
    const templates: Array<{ id: string; root: GuiHelperNode }> = [
      { id: 'depth_0', root: element('leaf', 1, 1) },
    ];
    for (let depth = 1; depth <= 128; depth += 1)
      templates.push({
        id: `depth_${depth}`,
        root: templateRef(`reference_${depth}`, `depth_${depth - 1}`),
      });
    expect(() =>
      compileGuiHelpers({
        version: 1,
        templates,
        root: templateRef('expanded', 'depth_128'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_HELPER_DEPTH_BUDGET_BLOCKED' }));
  });

  it('keeps merged template state variants within the per-node ceiling', () => {
    const variants = (start: number, count: number) =>
      Array.from({ length: count }, (_unused, offset) => {
        const index = start + offset;
        return { state: `state_${index}`, attributes: { clipping: index % 2 === 0 } };
      });
    expect(() =>
      compileGuiHelpers({
        version: 1,
        templates: [
          {
            id: 'variant_template',
            root: {
              id: 'variant_root',
              kind: 'row',
              stateVariants: variants(0, 32),
              children: [],
            },
          },
        ],
        root: {
          id: 'variant_instance',
          kind: 'template',
          templateId: 'variant_template',
          stateVariants: variants(32, 33),
          children: [],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_HELPER_STATE_VARIANT_BUDGET_BLOCKED' }));
  });

  it('blocks template-prefix amplification before generated names become disproportionate', () => {
    const longId = 'segment'.repeat(36).slice(0, 256);
    const templates: Array<{ id: string; root: GuiHelperNode }> = [
      { id: 'base', root: { id: longId, kind: 'row', children: [] } },
    ];
    for (let level = 1; level <= 3; level += 1)
      templates.push({
        id: `wrapper_${level}`,
        root: templateRef(longId, level === 1 ? 'base' : `wrapper_${level - 1}`),
      });
    expect(() =>
      compileGuiHelpers({
        version: 1,
        templates,
        root: templateRef(longId, 'wrapper_3'),
      }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_HELPER_IDENTIFIER_BUDGET_BLOCKED' }));
  });

  it('blocks disproportionate source work before compilation', () => {
    expect(() =>
      compileGuiHelpers({
        version: 1,
        root: {
          id: 'root',
          kind: 'column',
          children: [
            {
              id: 'large_text',
              kind: 'element',
              elementType: 'instantTextBoxType',
              text: 'x'.repeat(Math.ceil(GUI_HELPER_MAX_GENERATED_SOURCE_WORK / 8)),
              children: [],
            },
          ],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: 'GUI_HELPER_SOURCE_WORK_BUDGET_BLOCKED' }));
  });

  it('blocks generated bytes above the Clausewitz parser ceiling', () => {
    expect(() => assertGuiHelperGeneratedSourceBytes('££', 3)).toThrowError(
      expect.objectContaining({
        code: 'GUI_HELPER_SOURCE_BYTE_BUDGET_BLOCKED',
        details: { sourceBytes: 4, maximumBytes: 3 },
      }),
    );
  });

  it('keeps the helper schema strict', () => {
    expect(() =>
      compileGuiHelpers({
        version: 1,
        root: { id: 'root', kind: 'row', inventedField: true, children: [] },
      }),
    ).toThrow();
    expect(() =>
      compileGuiHelpers({
        version: 1,
        root: {
          id: 'root',
          kind: 'row',
          attributes: { 'unsafe key': true },
          children: [],
        },
      }),
    ).toThrow();
    expect(() =>
      compileGuiHelpers({
        version: 1,
        root: { id: 'wide_grid', kind: 'grid', columns: 10_001, children: [] },
      }),
    ).toThrow();
  });
});
