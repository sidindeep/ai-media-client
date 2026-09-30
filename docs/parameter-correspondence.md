# Общая таблица параметров Kie и APIMart

Словарь: 213 параметров верхнего уровня и 32 вложенных путей.
Kie: 173 уникальных полей; APIMart: 124.

Это полный снимок полей локальных каталогов проекта, а не обещание поддержки всех возможных полей API провайдеров.
Таблица общая, без отдельных таблиц для моделей. Первые столбцы — провайдеры, последний — наш параметр.
Словарь описывает соответствия названий. Он не загружен в runtime и не создаёт таблицу конвертаций в БД.
Каждый адаптер общается только со своим провайдером и проверяет тип, допустимые значения, роль исходника и ограничения по его схеме.
Одинаковое имя не гарантирует одинаковый смысл. При неоднозначности поле встречается в нескольких строках; условия перечислены ниже.
Составные объекты и списки сохраняются целиком. Пустая ячейка означает отсутствие такого имени в текущем каталоге провайдера.

В формах сервиса технические подписи параметров переведены через RU/EN-словарь
`composer.parameter.*`, включая поля внутри списков и объектов. API-имена остаются
исходными. Третий лист Excel «Параметры UI» содержит примеры моделей (и варианты
формы, где нужны) и фактические русские подписи, чтобы найти поле в интерфейсе.

## Все параметры

| Kie | APIMart | Наш параметр |
| --- | --- | --- |
| `acceleration` | — | `acceleration` |
| `align_audio` | — | `align_audio` |
| `align_audio_reverse` | — | `align_audio_reverse` |
| `aspectRatio`, `aspect_ratio`, `image_size`, `ratio`, `size` | `aspect_ratio`, `size` | `aspect_ratio` |
| — | `audio_file` | `audio_file` |
| — | `audio_format` | `audio_format` |
| `audio_id` | — | `audio_id` |
| `audio_ids` | — | `audio_ids` |
| `audio_setting` | `audio_setting` | `audio_setting` |
| `audio_url` | `audio_url` | `audio_url` |
| `audio_weight` | `audio_weight` | `audio_weight` |
| `author` | — | `author` |
| — | `auto_lyrics` | `auto_lyrics` |
| `background` | `background` | `background` |
| `background_source` | — | `background_source` |
| `bbox_list` | `bbox_list` | `bbox_list` |
| — | `bpm` | `bpm` |
| `callBackUrl` | — | `callBackUrl` |
| `camera_fixed`, `fixed_lens` | `camerafixed` | `camera_fixed` |
| `cfg_scale` | — | `cfg_scale` |
| — | `chaos` | `chaos` |
| `character_ids` | — | `character_ids` |
| `character_orientation` | `character_orientation` | `character_orientation` |
| `color_palette` | `color_palette` | `color_palette` |
| `content` | — | `content` |
| `continue_at` | — | `continue_at` |
| `n` | `n` | `count` |
| — | `cref` | `cref` |
| — | `custom` | `custom` |
| `custom_mode` | — | `custom_mode` |
| — | `custom_model_id` | `custom_model_id` |
| — | `cw` | `cw` |
| `default_param_flag` | — | `default_param_flag` |
| `description` | — | `description` |
| `dialogue` | — | `dialogue` |
| `dialogue_turns` | — | `dialogue_turns` |
| `domain_name` | — | `domain_name` |
| — | `draft` | `draft` |
| — | `draft_from_task_id` | `draft_from_task_id` |
| — | `dref` | `dref` |
| `driving_audio_url` | — | `driving_audio_url` |
| `duration` | `duration` | `duration` |
| — | `dw` | `dw` |
| `elements` | `element_list` | `element_list` |
| — | `enable_gif` | `enable_gif` |
| `enable_pro` | — | `enable_pro` |
| `enable_prompt_expansion` | — | `enable_prompt_expansion` |
| `enable_safety_checker` | — | `enable_safety_checker` |
| `enable_sequential` | `enable_sequential` | `enable_sequential` |
| `enableTranslation` | — | `enableTranslation` |
| `end_image_url` | — | `end_image_url` |
| — | `enhance_prompt` | `enhance_prompt` |
| `expand_prompt` | — | `expand_prompt` |
| `extend_at` | — | `extend_at` |
| `extend_times` | — | `extend_times` |
| — | `extra` | `extra` |
| — | `fast_pretreatment` | `fast_pretreatment` |
| — | `file_url` | `file_url` |
| `first_clip_url` | — | `first_clip_url` |
| `firstFrame`, `first_frame`, `first_frame_image_url`, `first_frame_url` | `first_frame_image` | `first_frame` |
| `frames_per_second` | — | `frames_per_second` |
| `full_lyrics` | — | `full_lyrics` |
| `audio`, `generate_audio`, `generate_audio_switch`, `sound` | `audio`, `generate_audio` | `generate_audio` |
| `generate_multi_clip_switch` | `generate_multi_clip_switch` | `generate_multi_clip_switch` |
| — | `generation_type` | `generation_type` |
| — | `google_image_search` | `google_image_search` |
| — | `google_search` | `google_search` |
| `grab_lyrics` | — | `grab_lyrics` |
| — | `guidance` | `guidance` |
| `guidance_scale` | — | `guidance_scale` |
| — | `hd` | `hd` |
| — | `height` | `height` |
| `image` | — | `image` |
| `image_resolution` | — | `image_resolution` |
| — | `image_with_roles` | `image_with_roles` |
| `index` | — | `index` |
| `infill_end_s` | — | `infill_end_s` |
| `infill_start_s` | — | `infill_start_s` |
| `instrumental` | `instrumental` | `instrumental` |
| — | `iw` | `iw` |
| — | `keep_original_sound` | `keep_original_sound` |
| `kling_elements` | — | `kling_elements` |
| `language` | `language` | `language` |
| `language_code` | — | `language_code` |
| `lastFrame`, `last_frame_image_url`, `last_frame_url` | `end_frame_image`, `last_frame_image` | `last_frame` |
| — | `layer_decomposition` | `layer_decomposition` |
| — | `length` | `length` |
| — | `link_url` | `link_url` |
| `lyrics` | `lyrics` | `lyrics` |
| `mask_indexs` | — | `mask_indexs` |
| `mask_url` | `mask_url` | `mask_url` |
| `max_images` | — | `max_images` |
| — | `max_mode` | `max_mode` |
| — | `metadata` | `metadata` |
| — | `mid_frame_images` | `mid_frame_images` |
| `mode` | `mode` | `mode` |
| `model` | — | `model` |
| — | `moderation` | `moderation` |
| — | `motion_mode` | `motion_mode` |
| `multi_prompt` | `multi_prompt` | `multi_prompt` |
| `customize_multi_shots` | `multi_shot` | `multi_shot` |
| `multi_shots` | — | `multi_shots` |
| `negative_prompt` | `negative_prompt` | `negative_prompt` |
| `negative_tags` | `negative_tags` | `negative_tags` |
| `next_text` | — | `next_text` |
| — | `niji` | `niji` |
| `nsfw_checker` | — | `nsfw_checker` |
| `num_frames` | — | `num_frames` |
| `num_images` | — | `num_images` |
| `num_inference_steps` | — | `num_inference_steps` |
| — | `official_fallback` | `official_fallback` |
| — | `omni_reference_task_type` | `omni_reference_task_type` |
| `open_scenedet` | — | `open_scenedet` |
| — | `optimize_prompt_options` | `optimize_prompt_options` |
| — | `output_compression` | `output_compression` |
| `outputFormat`, `output_format` | `output_format` | `output_format` |
| `output_resolution` | — | `output_resolution` |
| `pe_fast_mode` | — | `pe_fast_mode` |
| — | `person_generation` | `person_generation` |
| `persona_id` | `persona_id` | `persona_id` |
| `persona_model` | — | `persona_model` |
| `prefer_multi_shots` | — | `prefer_multi_shots` |
| `previous_text` | — | `previous_text` |
| `prompt` | `prompt` | `prompt` |
| `prompt_extend` | `prompt_extend` | `prompt_extend` |
| — | `prompt_extend_mode` | `prompt_extend_mode` |
| `prompt_optimizer` | `prompt_optimizer` | `prompt_optimizer` |
| `promptUpsampling` | `prompt_upsampling` | `prompt_upsampling` |
| `quality` | `quality` | `quality` |
| — | `raw` | `raw` |
| — | `ref_images` | `ref_images` |
| — | `ref_videos` | `ref_videos` |
| `audio_urls`, `reference_audio_urls` | `audio_urls` | `reference_audio` |
| `reference_file_urls` | — | `reference_file_urls` |
| `imageUrls`, `image_references`, `image_urls`, `reference_image`, `reference_image_urls` | `image_urls`, `img_references` | `reference_images` |
| `reference_link_urls` | — | `reference_link_urls` |
| `reference_mask_urls` | — | `reference_mask_urls` |
| `reference_video` | — | `reference_video` |
| `reference_video_urls`, `video_list`, `video_urls` | `video_list`, `video_urls` | `reference_videos` |
| `reference_voice` | — | `reference_voice` |
| `rendering_speed` | — | `rendering_speed` |
| — | `repeat` | `repeat` |
| — | `resize_mode` | `resize_mode` |
| `image_size`, `mode`, `quality`, `resolution` | `mode`, `quality`, `resolution` | `resolution` |
| — | `response_format` | `response_format` |
| `return_last_frame` | `return_last_frame` | `return_last_frame` |
| `safetyTolerance` | `safety_tolerance` | `safety_tolerance` |
| `sample_context` | — | `sample_context` |
| — | `sample_count` | `sample_count` |
| `scene` | — | `scene` |
| `seed` | `seed` | `seed` |
| `separate_vocal` | — | `separate_vocal` |
| — | `sequential_image_generation` | `sequential_image_generation` |
| — | `sequential_image_generation_options` | `sequential_image_generation_options` |
| `shift` | — | `shift` |
| — | `shot_type` | `shot_type` |
| `similarity_boost` | — | `similarity_boost` |
| `singer_skill_level` | — | `singer_skill_level` |
| `size` | `size` | `size` |
| `sound_key` | — | `sound_key` |
| `sound_loop` | — | `sound_loop` |
| `sound_tempo` | — | `sound_tempo` |
| `filesUrl`, `imageUrl`, `image_input`, `image_url`, `image_urls`, `inputImage`, `input_urls` | `image_url`, `image_urls` | `source_images` |
| — | `extend_from_task_id`, `source_task_id` | `source_task_id` |
| `video_url`, `video_urls` | `video_url`, `video_urls` | `source_videos` |
| `speakers` | — | `speakers` |
| `speed` | `speed` | `speed` |
| — | `sref` | `sref` |
| `stability` | — | `stability` |
| `stem_name` | — | `stem_name` |
| — | `steps` | `steps` |
| — | `stop` | `stop` |
| `strength` | — | `strength` |
| `style` | `style` | `style` |
| `style_weight` | `style_weight` | `style_weight` |
| — | `stylize` | `stylize` |
| — | `sw` | `sw` |
| `sync_mode` | — | `sync_mode` |
| `tags` | — | `tags` |
| `tail_image_url` | — | `tail_image_url` |
| `taskId`, `task_id` | — | `task_id` |
| `temperature` | — | `temperature` |
| `templ_start_seconds` | — | `templ_start_seconds` |
| — | `template` | `template` |
| `template_id` | — | `template_id` |
| `text` | — | `text` |
| `thinking_mode` | `thinking_mode` | `thinking_mode` |
| — | `tile` | `tile` |
| `timestamps` | — | `timestamps` |
| `title` | `title` | `title` |
| — | `tools` | `tools` |
| `type` | — | `type` |
| `upload_url` | — | `upload_url` |
| `upload_url_list` | — | `upload_url_list` |
| `uploadCn` | — | `uploadCn` |
| `upscale_factor` | — | `upscale_factor` |
| `variety` | `variety` | `variety` |
| `verify_url` | — | `verify_url` |
| — | `version` | `version` |
| — | `video` | `video` |
| `video_list` | `video_list` | `video_list` |
| `vocal_end_s` | — | `vocal_end_s` |
| `vocal_gender` | `vocal_gender` | `vocal_gender` |
| `vocal_start_s` | — | `vocal_start_s` |
| `voice` | `voice` | `voice` |
| `voice_name` | — | `voice_name` |
| `voice_url` | — | `voice_url` |
| `waterMark`, `watermark` | `watermark` | `watermark` |
| — | `watermark_info` | `watermark_info` |
| `web_search` | — | `web_search` |
| — | `weird` | `weird` |
| `weirdness_constraint` | `weirdness_constraint` | `weirdness_constraint` |
| — | `width` | `width` |

## Неоднозначные соответствия

- `mode`: Может означать режим/уровень качества. Как resolution — только при подтверждённом соответствии адаптера (например, Kling 4k). Значения std/pro требуют отдельной проверки.
- `quality`: Качество изображения и разрешение видео — разные значения. Выбор смысла и допустимых значений делает адаптер.
- `image_size`: В одних схемах разрешение, в других соотношение сторон. Контекст обязателен.
- `size`: Соотношение сторон, пиксельный размер или специальный размер операции. Нельзя безусловно переводить в aspect_ratio.
- `image_urls`: Исходное изображение, референсы или упорядоченные кадры. Роль определяется выбранным действием и адаптером.
- `video_urls`: Исходное видео и видео-референс различаются по роли; названия недостаточно для выбора.
- `video_list`: Может быть структурированным списком. Нельзя сводить к массиву URL с потерей ролей и метаданных.

Имена, оставленные без объединения (например, `steps` и `num_inference_steps`, `guidance` и `cfg_scale`), требуют подтверждения одинаковой семантики; похожего названия недостаточно.

## Вложенные параметры

`[]` обозначает элемент массива. Вложенный `duration`, `prompt` или `type` не смешивается с одноимённым параметром всего запроса.

| Kie | APIMart | Наш параметр |
| --- | --- | --- |
| `color_palette[].hex` | — | `color_palette[].hex` |
| `color_palette[].ratio` | — | `color_palette[].ratio` |
| `dialogue_turns[].speaker_id` | — | `dialogue_turns[].speaker_id` |
| `dialogue_turns[].text` | — | `dialogue_turns[].text` |
| `dialogue[].text` | — | `dialogue[].text` |
| `dialogue[].voice` | — | `dialogue[].voice` |
| `elements[].description` | — | `element_list[].description` |
| `elements[].element_input_audio_urls` | — | `element_list[].element_input_audio_urls` |
| `elements[].element_input_urls` | — | `element_list[].element_input_urls` |
| `elements[].end_time` | — | `element_list[].end_time` |
| `elements[].name` | — | `element_list[].name` |
| `elements[].start_time` | — | `element_list[].start_time` |
| `kling_elements[].description` | — | `kling_elements[].description` |
| `kling_elements[].element_input_audio_urls` | — | `kling_elements[].element_input_audio_urls` |
| `kling_elements[].element_input_urls` | — | `kling_elements[].element_input_urls` |
| `kling_elements[].end_time` | — | `kling_elements[].end_time` |
| `kling_elements[].name` | — | `kling_elements[].name` |
| `kling_elements[].start_time` | — | `kling_elements[].start_time` |
| `multi_prompt[].duration` | — | `multi_prompt[].duration` |
| `multi_prompt[].prompt` | — | `multi_prompt[].prompt` |
| `image_references[].image_url` | — | `reference_images[].image_url` |
| `image_references[].ref_name` | — | `reference_images[].ref_name` |
| `image_references[].type` | — | `reference_images[].type` |
| `speakers[].accent` | — | `speakers[].accent` |
| `speakers[].audio_profile` | — | `speakers[].audio_profile` |
| `speakers[].pace` | — | `speakers[].pace` |
| `speakers[].speaker_id` | — | `speakers[].speaker_id` |
| `speakers[].style` | — | `speakers[].style` |
| `speakers[].voice_name` | — | `speakers[].voice_name` |
| `video_list[].ends` | — | `video_list[].ends` |
| `video_list[].start` | — | `video_list[].start` |
| `video_list[].url` | — | `video_list[].url` |

## Источники и обновление

- Kie: `src/catalog`, схемы `inputSchema`, объединения вариантов и поля форм.
- APIMart: `config/apimart-schemas.json`, каталог `src/providers/apimart/catalog.js` и ID из `config/model-routes.json`.
- Основные подтверждённые синонимы: `src/media/generation-task.js`. Неоднозначные соответствия здесь — справочник для адаптеров, а не глобальные правила исполнения.
- Обновить: `node scripts/sync-parameter-correspondence.cjs`.
- Машиночитаемый снимок: `config/parameter-correspondence.json`.
- `__input` — техническое поле редактора JSON, не параметр API; исключено.
