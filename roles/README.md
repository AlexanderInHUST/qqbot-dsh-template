# 人格卡

`鱼妹.md` 是她的人格卡，docker-compose 把这个目录挂到 bridge 的 /opt/qq-bridge/roles。bridge 把它写成 state/role-card-v2.md，放在 qq-chat-v2 / qq-play 系统提示的最前面（`{{qq_role_card}}`），改了热生效，会话里旧的那份等压缩才换。

- 只写她是谁、怎么说话、喜欢什么，不写工具怎么用（那是 preset 的 persona 管的）。带引号的话是例子，不是口头禅。
- `<!-- grow:名字 -->…<!-- /grow:名字 -->` 包着的部分第一次启动时导入 extras 的 /data/self-profile.json，之后以档案为准，在这里改不生效（见 CLAUDE.md 的“长大”）。
- 文件名不能带 emoji（`sanitizeRoleName` 会删掉，人格卡静默不加载）；`README` 不算角色。
