export const messages = {
  zh: {
    title: 'JSON 导入', description: '粘贴账户数组或选择一个 JSON 文件，核对后确认导入。',
    input: '账户 JSON', file: '选择 JSON 文件', clear: '清空', confirm: '确定导入', cancel: '取消', close: '关闭',
    hint: '最大 2 MB。nickname、email 可选且分别保存。idc 必须提供 clientId、clientSecret；企业账号请提供 profileArn。authMethod 缺省为 social。',
    rules: '重复账户跳过；验活通过后启用。导入期间请保持本页打开。',
    reading: '正在读取文件…', importing: '正在导入并验活', account: '账户',
    invalidJson: '请输入有效的 JSON。', invalidShape: '请输入非空的账户数组，每项必须是账户对象。',
    invalidField: '字段必须是字符串。', missingToken: '缺少非空的 refreshToken。',
    invalidAuth: 'authMethod 仅支持 social / idc；idc 必须同时提供 clientId 和 clientSecret，social 不应携带这两个字段。',
    invalidEmail: '邮箱格式不正确。', invalidProvider: 'social 的 provider 支持 Google / GitHub，idc 支持 Enterprise；也可省略。',
    tooLarge: '账户信息不能超过 2 MB。', invalidFile: '请选择一个 .json 文件。', fileReadFailed: '无法读取文件，请重试或直接粘贴 JSON。',
    success: '导入成功，已启用', duplicate: '账户已存在，已跳过', failed: '导入失败，请检查账户信息和网络',
    unverified: '已创建但验活失败，保持禁用，请到列表检查', activationUnknown: '已创建并通过验活，启用结果未确认，请到列表检查',
  },
  en: {
    title: 'JSON import', description: 'Paste an account array or select one JSON file, then review and confirm.',
    input: 'Account JSON', file: 'Select JSON file', clear: 'Clear', confirm: 'Confirm import', cancel: 'Cancel', close: 'Close',
    hint: 'Maximum 2 MB. nickname and email are optional and stored separately. idc requires clientId and clientSecret; include profileArn for enterprise accounts. authMethod defaults to social.',
    rules: 'Duplicates are skipped; accounts are enabled after verification. Keep this page open during import.',
    reading: 'Reading file…', importing: 'Importing and verifying', account: 'Account',
    invalidJson: 'Enter valid JSON.', invalidShape: 'Enter a non-empty array of account objects.',
    invalidField: 'The field must be a string.', missingToken: 'A non-empty refreshToken is required.',
    invalidAuth: 'authMethod must be social or idc. idc requires both clientId and clientSecret; social must omit them.',
    invalidEmail: 'The email format is invalid.', invalidProvider: 'social supports Google / GitHub; idc supports Enterprise. provider may also be omitted.',
    tooLarge: 'Account data must not exceed 2 MB.', invalidFile: 'Select one .json file.', fileReadFailed: 'Could not read the file. Retry or paste JSON directly.',
    success: 'Imported and enabled', duplicate: 'Account already exists; skipped', failed: 'Import failed; check the account data and connection',
    unverified: 'Created but verification failed; remains disabled. Check the account list', activationUnknown: 'Created and verified, but activation is unconfirmed. Check the account list',
  },
} as const

export const example = JSON.stringify([{
  nickname: 'Work account', email: 'name@example.com', authMethod: 'idc', provider: 'Enterprise',
  refreshToken: '<refreshToken>', clientId: '<clientId>', clientSecret: '<clientSecret>',
  profileArn: '<profileArn>', authRegion: 'us-east-1', apiRegion: 'us-east-1',
}], null, 2)
