export const CONFIG = {
  // 检测/读取分辨率（长边）
  // 实时检测不能太低：手机屏幕上的九宫格细线在 720 下会整体消失
  // （同一帧 840 以上就能检出），表现就是“不定格识别不出、定格能识别”。
  // 960 在桌面约 2× 720 的耗时（十几毫秒），仍有足够帧率。
  detectLongSide: 960,
  detectLongSideStatic: 1200,
  readLongSide: 1600,

  // 透视校正尺寸，每格 100px
  warpSize: 900,

  // 双读共识的内缩量。B 不能太大：数字在格里通常偏下，
  // 内缩 15px 会切到字形底部，被判成“贴边墨迹”。
  cellInsetA: 11,
  cellInsetB: 8,
  cellMinStd: 7,
  // Otsu 把格子分成两类后，两类均值差小于这个灰度级就当空格：
  // 屏幕摩尔纹/压缩噪点只有十几级，真实数字（印刷或屏幕）在 100 以上。
  cellMinContrast: 26,
  // 4 邻域腐蚀后剩余墨量（占整格比例）的下限。数字笔画粗，细线和噪点
  // 经不住腐蚀——用它把“有纹理”和“有字形”分开。
  cellMinCore: 0.0026,

  // 默认处理帧率与可选项（30fps 与摄像头的采集帧率对齐；
  // 检测在 960 长边约 15ms，桌面端能稳定跑满）
  detectFps: 30,
  fpsOptions: [6, 10, 12, 15, 20, 30],

  // 叠加
  digitColor: 'rgba(0, 150, 70, 0.95)',
  digitHalo: 'rgba(0, 0, 0, 0.5)',
  unknownColor: 'rgba(230, 150, 20, 0.95)',
  fadeMs: 150,

  // 输出
  opencvVersion: '4.12.0',
};
