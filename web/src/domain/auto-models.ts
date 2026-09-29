import type { ApimartCatalog, Catalog } from '../types';
import { apimartModelBrandId, mediaModelBrandId, type ModelPickerOption } from './model-catalog';
import compatibility from '../../../config/cost-routing-compatibility.json';

export function autoModelOptions(kie: Catalog['models'], apimart: ApimartCatalog['models'], mode: string): ModelPickerOption[] {
  const options: ModelPickerOption[] = [];
  for (const model of kie) {
    if ((model.kind || 'image') !== mode) continue;
    options.push({ value: model.id, label: model.name.trim(), description: model.description,
      groupId: mediaModelBrandId(model.id, model.name) });
  }
  for (const model of apimart) {
    if (model.kind !== mode || compatibility.pairs.some(pair => pair.apimart === model.id && kie.some(item => item.id === pair.kie))) continue;
    options.push({ value: `apimart:${model.id}`, label: model.name.trim(), description: 'APIMart',
      groupId: apimartModelBrandId(model.id) });
  }
  return options;
}
