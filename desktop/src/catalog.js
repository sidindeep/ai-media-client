const providers = [
  {
    id: "kie",
    name: "Kie.ai",
    baseUrl: "https://api.kie.ai",
    uploadUrl: "https://kieai.redpandaai.co/api/file-stream-upload",
    balancePath: "/api/v1/chat/credit",
    createPath: "/api/v1/jobs/createTask",
    taskPath: "/api/v1/jobs/recordInfo"
  }
];

const models = [
  {
    id: "kie:grok-imagine-video-1-5-preview",
    providerId: "kie",
    apiModel: "grok-imagine-video-1-5-preview",
    name: "Grok Imagine Video 1.5 Preview",
    kind: "video",
    description: "Текст или до 7 изображений → видео с нативным аудио",
    pricing: { type: "reported", label: "Фактическая стоимость появится после запуска" },
    fields: [
      { key: "prompt", label: "Промпт", type: "textarea", required: true, maxLength: 4096 },
      { key: "image_urls", label: "Референсные изображения", type: "files", accept: "image/jpeg,image/png,image/webp", maxFiles: 7, maxSizeMb: 20 },
      { key: "aspect_ratio", label: "Соотношение сторон", type: "select", options: ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"], default: "16:9" },
      { key: "resolution", label: "Разрешение", type: "select", options: ["480p", "720p", "1080p"], default: "720p" },
      { key: "duration", label: "Длительность, сек.", type: "number", min: 1, max: 15, default: 8 },
      { key: "nsfw_checker", label: "Проверка NSFW", type: "boolean", default: true }
    ]
  }
];

const imported = require('./kie-models.json');
const special = require('./kie-special.json');
const {applyOverrides}=require('./catalog-overrides');
module.exports = { providers, models: applyOverrides([...imported, ...special, ...models.filter(model => !imported.some(item => item.id === model.id))]) };
