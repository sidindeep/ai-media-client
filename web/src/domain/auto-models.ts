import type { ApimartCatalog, Catalog, ServiceModelRow } from '../types';
import { apimartModelBrandId, mediaModelBrandId, type ModelPickerOption } from './model-catalog';

export function serviceNameForKie(id: string, rows: ServiceModelRow[]): string | undefined {
  return rows.find(row => row.kie === id)?.name;
}

export function serviceNameForApimart(id: string, rows: ServiceModelRow[]): string | undefined {
  const matches = rows.filter(row => row.apimart === id);
  if (!matches?.length) return undefined;
  if (matches.length === 1) return matches[0].name;
  let common = matches[0].name;
  for (const row of matches.slice(1)) {
    while (common && !row.name.startsWith(common)) common = common.slice(0, -1);
  }
  return common.replace(/[\s—–-]+$/, '') || matches[0].name;
}

export function autoModelOptions(kie: Catalog['models'], apimart: ApimartCatalog['models'], mode: string,
  selectedValue: string, rows: ServiceModelRow[], listedOnly = false): ModelPickerOption[] {
  const kieById = new Map(kie.filter(model => (model.kind || 'image') === mode).map(model => [model.id, model]));
  const apimartById = new Map(apimart.filter(model => model.kind === mode).map(model => [model.id, model]));
  const usedKie = new Set<string>();
  const usedApimart = new Set<string>();
  const options: ModelPickerOption[] = [];
  for (const row of rows) {
    if (row.kind !== mode) continue;
    const kieModel = row.kie ? kieById.get(row.kie) : undefined;
    const apimartModel = row.apimart ? apimartById.get(row.apimart) : undefined;
    if (kieModel) {
      options.push({ value: kieModel.id, label: row.name, description: kieModel.description,
        groupId: mediaModelBrandId(kieModel.id, row.name) });
      usedKie.add(kieModel.id);
      if (apimartModel) usedApimart.add(apimartModel.id);
    } else if (apimartModel && !usedApimart.has(apimartModel.id)) {
      options.push({ value: `apimart:${apimartModel.id}`, label: row.name, description: 'APIMart',
        groupId: apimartModelBrandId(apimartModel.id) });
      usedApimart.add(apimartModel.id);
    }
  }
  // Once a versioned service list is loaded, only its priced rows are visible.
  if (listedOnly) return options;
  for (const model of kieById.values()) {
    if (!usedKie.has(model.id)) options.push({ value: model.id, label: model.name.trim(),
      description: model.description, groupId: mediaModelBrandId(model.id, model.name) });
  }
  for (const model of apimartById.values()) {
    if (options.some(option => option.value === `apimart:${model.id}`)) continue;
    if (usedApimart.has(model.id) && selectedValue !== `apimart:${model.id}`) continue;
    options.push({ value: `apimart:${model.id}`, label: serviceNameForApimart(model.id, rows) || model.name.trim(),
      description: 'APIMart', groupId: apimartModelBrandId(model.id) });
  }
  return options;
}
