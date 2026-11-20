# BookFish 浏览器桥接扩展（协议 v2）

当前为隔离审核版本，未通过实际 MV3／Coopanion 验收。正式 World 尚未接入受保护浏览器控制器；缺少独立保护授权时任务会拒绝，配对成功不代表可下载。不得使用日常浏览器或关闭保护绕过阻断。

审核后在独立 Chrome／Edge 配置中手工“加载已解压的扩展程序”，选择本目录。端口和令牌仅来自隔离 BookFish 数据目录；在弹窗填写来源 URL，点授权。仅明示授权的精确 origin 可用；撤销来源／修改配对设置会取消进行中的传输。Chrome 的主机权限按主机授权，工作线程另做精确 origin 检查。

权限为 storage、alarms、本机127.0.0.1桥接及可选 HTTP／HTTPS 来源权限；无固定 all_urls、代理、debugger 或 Cookie 导出权限。协议v2要求消费者租约、序号和完成字节数，v1不能混用。HTTPS使用浏览器已有登录态，HTTP不带凭据；不代登录、付费或绕过验证。

重定向一律拒绝。页面最多8MiB、文件最多100MiB、单次上传块最多4MiB，原始字节不转码，失败／超时取消读取。令牌只存本机；不要粘贴到聊天、日志或截图中。

审核状态和尚未覆盖的安全边界见 docs/txt-acquisition/ROUND2-IMPLEMENTATION-REVIEW.md。
