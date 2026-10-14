import { describe, expect, it } from 'vitest';
import { sha256Bytes } from '../../src/hoi4_agent_tools/core/canonical.js';
import { SymbolIndex } from '../../src/hoi4_agent_tools/core/index.js';
import type { ScannedFile } from '../../src/hoi4_agent_tools/core/scanner.js';
import { buildGuiScene } from '../../src/hoi4_agent_tools/gui/layout.js';
import { buildGuiSourceGraph } from '../../src/hoi4_agent_tools/gui/source-graph.js';
import { parsePreviewScenario } from '../../src/hoi4_agent_tools/gui/scenario.js';

async function sceneFor(
  source: string,
  values: Record<string, unknown> = {},
  windowName = 'countrydivisiondesignerview',
) {
  const bytes = Buffer.from(`guiTypes = { ${source} }`);
  const files: ScannedFile[] = [
    {
      displayPath: 'fixture:interface/panels.gui',
      absolutePath: '/synthetic/interface/panels.gui',
      relativePath: 'interface/panels.gui',
      rootKind: 'fixture',
      loadOrder: 0,
      size: bytes.length,
      modifiedMs: 0,
      sha256: sha256Bytes(bytes),
      bytes,
    },
  ];
  return buildGuiScene(
    buildGuiSourceGraph(files, SymbolIndex.build(files)),
    files,
    windowName,
    parsePreviewScenario({ id: 'panels', resolution: { width: 400, height: 300 }, ...values }),
  );
}

const division = `containerWindowType = { name = "countrydivisiondesignerview" orientation = center origo = center size = { width = 300 height = 200 }
  containerWindowType = { name = "hq_overlay_images" size = { width = 300 height = 200 }
    buttonType = { name = "hq_child" size = { width = 30 height = 20 } } }
  containerWindowType = { name = "subunits_hq" size = { width = 100 height = 100 } }
  containerWindowType = { name = "hq_view" size = { width = 100 height = 100 } }
  containerWindowType = { name = "non_hq_view" size = { width = 100 height = 100 } }
  containerWindowType = { name = "subunits" size = { width = 100 height = 100 } }
  instantTextboxType = { name = "division_title" text = "Division" size = { width = 100 height = 20 } }
  containerWindowType = { name = "division_equipment_view" position = { x = 10 y = 20 } size = { width = 200 height = 150 }
    instantTextboxType = { name = "division_title" text = "Equipment" size = { width = 100 height = 20 } } }
  containerWindowType = { name = "designerregimentswindow" size = { width = 100 height = 100 } }
  containerWindowType = { name = "div_templ_custom_icon_view" size = { width = 100 height = 100 } }
  containerWindowType = { name = "div_template_select_model" size = { width = 100 height = 100 } }
  containerWindowType = { name = "niche_icon_selector" size = { width = 100 height = 100 } }
  buttonType = { name = "later_control" size = { width = 50 height = 40 } }
}`;

describe('native panel composition', () => {
  it('anchors children to the local upper left and closes native selectors and HQ overlays by default', async () => {
    const scene = await sceneFor(division);
    for (const name of [
      'hq_overlay_images',
      'hq_child',
      'hq_view',
      'subunits_hq',
      'division_equipment_view',
      'designerregimentswindow',
      'div_templ_custom_icon_view',
      'div_template_select_model',
      'niche_icon_selector',
    ]) {
      const element = scene.elements.find((element) => element.name === name)!;
      expect(element.visible, name).toBe(false);
      expect(element.clickable, name).toBe(false);
    }
    expect(scene.elements.find(({ name }) => name === 'subunits')).toMatchObject({
      visible: true,
      unclippedRect: { x: 50, y: 50, width: 100, height: 100 },
    });
    expect(
      scene.fidelity.approximated.some(({ detail }) => detail.includes('selectors closed')),
    ).toBe(true);
  });

  it('selects HQ and one panel without hiding identically named panel controls', async () => {
    const scene = await sceneFor(division, {
      values: {
        'countrydivisiondesignerview.hq': true,
        'countrydivisiondesignerview.panel': 'division_equipment_view',
      },
    });
    expect(scene.elements.find(({ name }) => name === 'hq_child')!.visible).toBe(true);
    for (const name of ['non_hq_view', 'subunits', 'designerregimentswindow'])
      expect(scene.elements.find((element) => element.name === name)!.visible).toBe(false);
    const titles = scene.elements.filter(({ name }) => name === 'division_title');
    expect(titles.map(({ visible }) => visible)).toEqual([false, true]);
    expect(
      scene.elements.findIndex(({ name }) => name === 'division_equipment_view'),
    ).toBeGreaterThan(scene.elements.findIndex(({ name }) => name === 'later_control'));
    expect(
      scene.elements.find(({ name }) => name === 'division_equipment_view')!.unclippedRect,
    ).toEqual({ x: 60, y: 70, width: 200, height: 150 });
  });

  it('honours visibility, id and value overrides; does not guess unknown panels or unrelated windows', async () => {
    const initial = await sceneFor(division);
    const id = initial.elements.find(({ name }) => name === 'niche_icon_selector')!.id;
    const scene = await sceneFor(division, {
      visibility: { hq_view: true, [id]: true },
      values: {
        'division_equipment_view.visible': true,
        'countrydivisiondesignerview.panel': 'unknown',
      },
    });
    for (const name of ['hq_view', 'niche_icon_selector', 'division_equipment_view'])
      expect(scene.elements.find((element) => element.name === name)!.visible).toBe(true);
    expect(scene.elements.find(({ name }) => name === 'designerregimentswindow')!.visible).toBe(
      false,
    );
    const other = await sceneFor(
      division.replace('countrydivisiondesignerview', 'unrelated'),
      {},
      'unrelated',
    );
    expect(other.elements.find(({ name }) => name === 'hq_child')!.visible).toBe(true);
  });

  it('keeps dropdown role boundaries, hides their descendants and opens only the bound dropdown', async () => {
    const dropdown = (
      name: string,
      x: number,
    ) => `dropDownBoxType = { name = "${name}" position = { x = ${x} y = 10 } size = { width = 100 height = 20 }
      expandButton = { name = "expand_button" size = { width = 10 height = 10 } }
      expandedWindow = { name = "expanded_window" position = { x = 0 y = -60 } show_position = { x = 0 y = 20 } size = { width = 100 height = 80 } clipping = yes
        buttonType = { name = "row" position = { x = 0 y = 5 } size = { width = 30 height = 20 } }
      } }`;
    const source = `containerWindowType = { name = "dropdown_test" size = { width = 300 height = 200 } ${dropdown('first', 10)} ${dropdown('second', 150)} }`;
    const closed = await sceneFor(source, {}, 'dropdown_test');
    expect(closed.elements.filter(({ name }) => name === 'expanded_window')).toHaveLength(2);
    expect(
      closed.elements
        .filter(({ name }) => name === 'row')
        .every(({ visible, clickable }) => !visible && !clickable),
    ).toBe(true);
    expect(
      closed.elements
        .filter(({ name }) => name === 'expand_button')
        .every(({ visible, clickable }) => visible && clickable),
    ).toBe(true);
    const open = await sceneFor(source, { values: { 'first.expanded': true } }, 'dropdown_test');
    const panels = open.elements.filter(({ name }) => name === 'expanded_window');
    expect(panels.map(({ visible }) => visible)).toEqual([true, false]);
    expect(panels[0]!.unclippedRect).toEqual({ x: 10, y: 30, width: 100, height: 80 });
    expect(open.elements.find(({ name }) => name === 'row')).toMatchObject({
      parentId: panels[0]!.id,
      visible: true,
      unclippedRect: { x: 10, y: 35, width: 30, height: 20 },
    });
    const forced = await sceneFor(
      source,
      { visibility: { [panels[1]!.id]: true } },
      'dropdown_test',
    );
    expect(
      forced.elements.filter(({ name }) => name === 'row').map(({ visible }) => visible),
    ).toEqual([false, true]);
  });

  it('does not promote arbitrary expandedWindow metadata outside a dropdown into a panel', async () => {
    const scene = await sceneFor(
      'containerWindowType = { name = "root" size = { width = 100 height = 100 } expandedWindow = { name = "metadata" size = { width = 20 height = 20 } } }',
      {},
      'root',
    );
    expect(scene.elements.some(({ name }) => name === 'metadata')).toBe(false);
  });
});
