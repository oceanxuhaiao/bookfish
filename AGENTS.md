# AGENTS.md

Release checklist for this Cortico World extension. How to write one:
[docs/worlds.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/worlds.md) and [docs/extensions.md](https://github.com/Pal-AI-Lab/Cortico/blob/main/docs/extensions.md).
`pnpm describe:extension <dir>` and `pnpm check:extension <dir>` run from the root of a Cortico
checkout; `<dir>` is this package's directory.

- [ ] **Contract version**: `cortico.api` equals the world version on the `Contracts:` line that
  `check:extension` prints. A package with any other value does not load.
- [ ] **Self-description**: after changing tools, event types or the env prompt, run `pnpm describe:extension <dir>`.
  `cortico.describe` names the written file and `files` ships it.
- [ ] **Tags**: `cortico.tags` lists every tag in [TAGS.md](https://github.com/Pal-AI-Lab/cortico-extensions/blob/main/TAGS.md) whose "when"
  fits, notice and warning tags included.
- [ ] **CHANGELOG.md** has a `## <version>` section for the version being published.
- [ ] **`os`**: set the npm `os` field when the package runs only on some platforms.
- [ ] **`pnpm check:extension <dir>`** passes. Its "Before publishing" section reports the items
  above for this package.
- [ ] **Requests to the maintainers** (tag changes, certification, a replacement package, appeals)
  are issues in [Pal-AI-Lab/cortico-extensions](https://github.com/Pal-AI-Lab/cortico-extensions), in the plain-text format that
  `check:extension` prints and the [README](https://github.com/Pal-AI-Lab/cortico-extensions#readme) describes.

## BookFish 长期原则：Token 效率优先

本包属于《看书吧！大肥鱼》。涉及模型调用、提示词、工具回执、阅读上下文或批量策略的改动，必须遵守设计资料库
（与本工作区相邻的 `看书吧！大肥鱼/`）中的 `docs/Token效率优先原则.md`：

- 同一产品效果优先低成本方案；额外消耗必须带来不可替代的体验价值，不能只写“效果更好”。
- 不跳读、不伪造已读、不削弱大肥鱼的人格、真实阅读与记忆一致性；这些红线不能用省 Token 交换。
- 确定性逻辑本地完成；不重复传上下文；可缓存/持久化的不重复调用；按需加载、增量处理、合理批量。
- 设计时回答：为何需要模型、哪些可本地完成、有无同等体验的低耗替代、是否重复调用/传上下文/输出、增加消耗的产品价值。
- 显著影响消耗的改动：先取基线，改后同口径对比，并检查阅读质量、人格一致性与交互体验；无法测量须标注，禁止虚构收益。
- 产品红线与每万字 Token 验收口径以《Token 消耗优化：DSH 实施任务书》为准；本原则不替代实测，也不替代宿主验证。
