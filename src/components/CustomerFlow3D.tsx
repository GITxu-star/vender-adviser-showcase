import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { useStore } from '../store/useStore';

// ============ 场景坐标 ============
// 3D 世界：X 是主干道延伸方向，Y 是高度，Z 是摊位-主干道方向
// 主干道沿 X 轴从 -8 到 +8（单位：米）
// 摊位在 Z>0 一侧，主干道在 Z≈0
const ROAD_Z = 0;           // 主干道中心线 Z
const WORLD_MIN_X = -8;
const WORLD_MAX_X = 8;
const STALL_WIDTH = 2.8;    // 摊位宽度（沿 X）
const STALL_DEPTH = 1.8;    // 摊位深度（沿 Z）
const STALL_HEIGHT = 1.0;   // 摊位高度（Y）
const SIGN_HEIGHT = 0.8;    // 招牌高度
const SIGN_WIDTH = 1.8;     // 招牌宽度

// ============ 辅助函数 ============
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/** 摊位形状推断（复用 2D 版逻辑） */
function stallShape(stallType: string): 'rect' | 'cart' | 'table' | 'mat' {
  const n = stallType.split('（')[0].trim();
  if (['4', '5', '6', '7'].includes(n)) return 'cart';
  if (['2', '3'].includes(n)) return 'table';
  if (n === '9') return 'mat';
  return 'rect';
}

/** 2D→3D 坐标映射（马路在 Z≈0 中间，摊位可以落在两侧） */
function map2DTo3D(pt2D: { x: number; y: number }) {
  // 2D: W=400, H=300; 3D: X ∈ [-8, 8], Z ∈ [-6, 6]（y 上半 → 马路近侧，下半 → 马路远侧）
  const x3 = WORLD_MIN_X + (pt2D.x / 400) * (WORLD_MAX_X - WORLD_MIN_X);
  const z3 = 6 - (pt2D.y / 300) * 12;
  return { x: clamp(x3, WORLD_MIN_X + 1, WORLD_MAX_X - 1), z: clamp(z3, -6, 6) };
}

export default function CustomerFlow3D() {
  const screen1 = useStore(s => s.screen1);
  const judgment = useStore(s => s.judgment);
  const solution = useStore(s => s.solution);

  // 2D 拖拽坐标（用于 3D 映射 + 与旧版逻辑兼容）
  const [from2D, setFrom2D] = useState({ x: 50, y: 110 });
  const [to2D, setTo2D] = useState({ x: 350, y: 110 });
  const [stall2D, setStall2D] = useState({ x: 200, y: 60 });
  const [paused, setPaused] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  // 用 ref 桥接最新 2D state（effect 只在 mount 跑一次，animation loop 需要实时值）
  const fromRef = useRef(from2D); fromRef.current = from2D;
  const toRef = useRef(to2D); toRef.current = to2D;
  const stallRef = useRef(stall2D); stallRef.current = stall2D;

  // ============ 纯几何推理（复用 2D 版逻辑但转为 3D 结论） ============
  const analysis = useMemo(() => {
    const dir: 1 | -1 = to2D.x >= from2D.x ? 1 : -1;
    const comeFrom = dir === 1 ? '左边' : '右边';
    const lo = Math.min(from2D.x, to2D.x);
    const hi = Math.max(from2D.x, to2D.x);
    const width = Math.max(hi - lo, 1);
    const offLeft = Math.max(0, lo - 16 - stall2D.x);
    const offRight = Math.max(0, stall2D.x - (hi + 16));
    const offset = Math.max(offLeft, offRight);
    const ratio = clamp((stall2D.x - lo) / width, 0, 1);

    // 3D 坐标
    const from3 = map2DTo3D(from2D);
    const to3 = map2DTo3D(to2D);
    const stall3 = map2DTo3D(stall2D);

    // AI 关键词
    const aiText = (judgment?.howToFix ?? '') + ' ' + (judgment?.angles ?? '') + ' ' + (solution?.doWhat ?? '');
    const aiHasSign = /招牌|标牌|牌子/.test(aiText);
    const aiHasLayout = /摆|摆放|陈列|主打|展示/.test(aiText);
    const aiHasMove = /挪|移|换|往前|往后|上游|下游|偏/.test(aiText);

    // 招牌朝向（人流来向）：3D 里就是 from3.x 方向
    // 主打品摆放侧：招牌同侧（人流来向那一侧的摊位前半部分）
    // 挪位目标：
    let moveTarget3: { x: number; z: number } | null = null;
    let moveTone: 'warn' | 'bad' | null = null;
    if (offset > 0) {
      // 偏线 → 挪到主干道中线对应的 X
      moveTarget3 = { x: stall3.x, z: ROAD_Z + 1.2 }; // 挪到路边
      moveTone = 'bad';
    } else if (ratio > 0.72) {
      // 下游末段 → 挪到上游 35% 处
      moveTarget3 = {
        x: from3.x + (to3.x - from3.x) * 0.35,
        z: stall3.z,
      };
      moveTone = 'warn';
    }

    return { dir, comeFrom, offset, ratio, from3, to3, stall3, moveTarget3, moveTone, aiHasSign, aiHasLayout, aiHasMove };
  }, [from2D, to2D, stall2D, judgment, solution]);

  const dirLabel = analysis.dir === 1 ? '左 → 右' : '右 → 左';
  const shape = stallShape(screen1.stallType || '');

  // ============ Three.js 场景初始化 ============
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // --- 渲染器 ---
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0xf0f4f0, 1);

    // --- 场景 ---
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xf0f4f0, 15, 35);

    // --- 相机（球坐标 OrbitControls 自实现）---
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    let camTheta = Math.PI * 0.25;    // 水平角（绕 Y）
    let camPhi = Math.PI * 0.35;      // 垂直角（从 Y 轴下量，0=正上）
    let camDistance = 14;
    const camTarget = new THREE.Vector3(0, 0.5, 2);
    const updateCam = () => {
      camera.position.set(
        camTarget.x + camDistance * Math.sin(camPhi) * Math.cos(camTheta),
        camTarget.y + camDistance * Math.cos(camPhi),
        camTarget.z + camDistance * Math.sin(camPhi) * Math.sin(camTheta)
      );
      camera.lookAt(camTarget);
    };
    updateCam();

    // --- 灯光 ---
    const hemi = new THREE.HemisphereLight(0xffffff, 0xd9d9d9, 0.7);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff5e6, 1.1);
    sun.position.set(8, 12, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 30;
    sun.shadow.camera.left = -10;
    sun.shadow.camera.right = 10;
    sun.shadow.camera.top = 10;
    sun.shadow.camera.bottom = -10;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbfdbfe, 0.35);
    fill.position.set(-5, 6, -3);
    scene.add(fill);

    // --- 地面（深灰水泥地）---
    const groundGeo = new THREE.PlaneGeometry(24, 16);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0xe8e5e0, roughness: 0.95 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = 0;
    ground.receiveShadow = true;
    scene.add(ground);

    // 地面网格线（淡绿）
    const gridHelper = new THREE.GridHelper(24, 24, 0x9bb6a8, 0xd4e0d8);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.45;
    gridHelper.position.y = 0.01;
    scene.add(gridHelper);

    // --- 主干道（深色沥青路，带白虚线）---
    const roadGeo = new THREE.PlaneGeometry(16, 3.2);
    const roadMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.85 });
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, 0.02, ROAD_Z);
    road.receiveShadow = true;
    scene.add(road);

    // 人行道（路沿石 + 浅色人行道）
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xcfcecc, roughness: 0.9 });
    [-1.7, 1.7].forEach(offset => {
      const sw = new THREE.Mesh(new THREE.PlaneGeometry(16, 0.6), sidewalkMat);
      sw.rotation.x = -Math.PI / 2;
      sw.position.set(0, 0.03, ROAD_Z + offset);
      sw.receiveShadow = true;
      scene.add(sw);
    });

    // --- 街道两侧的邻居摊位（真实街道不止你一个摊，两侧都该有摊和人）---
    const neighborGroup = new THREE.Group();
    scene.add(neighborGroup);
    {
      const palette = [0xdbeafe, 0xfef3c7, 0xfde2e2, 0xe5e7eb];
      const neighborPlacements = [
        { x: -5.6, z: 3.4 }, { x: 5.4, z: 3.4 },
        { x: -4.2, z: -3.4 }, { x: -0.6, z: -3.4 }, { x: 3.2, z: -3.4 }, { x: 6.6, z: -3.4 },
      ];
      neighborPlacements.forEach((p, i) => {
        const g = new THREE.Group();
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(2.4, 0.95, 1.5),
          new THREE.MeshStandardMaterial({ color: 0xf3f4f6, roughness: 0.85 })
        );
        body.position.y = 0.48;
        body.castShadow = true;
        body.receiveShadow = true;
        g.add(body);
        const awning = new THREE.Mesh(
          new THREE.BoxGeometry(2.6, 0.08, 1.7),
          new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 0.7 })
        );
        awning.position.y = 1.35;
        awning.castShadow = true;
        g.add(awning);
        [-1.05, 1.05].forEach(dx => {
          const pole = new THREE.Mesh(
            new THREE.CylinderGeometry(0.035, 0.035, 1.35, 8),
            new THREE.MeshStandardMaterial({ color: 0x9ca3af })
          );
          pole.position.set(dx, 0.68, 0.7);
          g.add(pole);
        });
        g.position.set(p.x, 0, p.z);
        neighborGroup.add(g);
      });
      // 马路中心虚线：让"路在中间、摊在两侧"一眼看清
      const dashMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f4, roughness: 0.7 });
      for (let i = -7; i <= 7; i += 1.2) {
        const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.12), dashMat);
        dash.rotation.x = -Math.PI / 2;
        dash.position.set(i, 0.03, ROAD_Z);
        neighborGroup.add(dash);
      }
    }

    // --- 摊位（组）---
    const stallGroup = new THREE.Group();
    stallGroup.userData.dragKey = 'stall';
    scene.add(stallGroup);

    // --- 路面 from/to 标记（可拖拽，拖了人流方向跟着变）---
    const fromMarkerGroup = new THREE.Group();
    fromMarkerGroup.userData.dragKey = 'from';
    scene.add(fromMarkerGroup);
    {
      const { x, z } = analysis.from3;
      fromMarkerGroup.position.set(x, 0, z);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x1f7a44, emissive: 0x1f7a44, emissiveIntensity: 0.35, roughness: 0.4 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.07, 12, 28), ringMat);
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
      fromMarkerGroup.add(ring);
      const arrowMat = new THREE.MeshStandardMaterial({ color: 0x1f7a44, emissive: 0x0a3a20, emissiveIntensity: 0.25 });
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 20), arrowMat);
      arrow.position.y = 0.42;
      fromMarkerGroup.add(arrow);
      // 向上的"←→"小提示牌（Sprite）
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 40;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = 'rgba(31,122,68,0.9)';
      cx.beginPath(); cx.roundRect(0, 4, 120, 32, 8); cx.fill();
      cx.fillStyle = '#fff'; cx.font = 'bold 17px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText('从这来', 64, 20);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sp.position.set(0, 0.95, 0);
      sp.scale.set(1.6, 0.5, 1);
      fromMarkerGroup.add(sp);
    }
    const toMarkerGroup = new THREE.Group();
    toMarkerGroup.userData.dragKey = 'to';
    scene.add(toMarkerGroup);
    {
      const { x, z } = analysis.to3;
      toMarkerGroup.position.set(x, 0, z);
      const ringMat = new THREE.MeshStandardMaterial({ color: 0x475569, emissive: 0x475569, emissiveIntensity: 0.25, roughness: 0.4 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.38, 0.07, 12, 28), ringMat);
      ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02;
      toMarkerGroup.add(ring);
      // 小旗杆 + 旗帜
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x374151 });
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1.0, 8), poleMat);
      pole.position.y = 0.5;
      toMarkerGroup.add(pole);
      const flagMat = new THREE.MeshStandardMaterial({ color: 0x475569, side: THREE.DoubleSide, roughness: 0.5 });
      const flag = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.35, 4), flagMat);
      flag.position.set(0.12, 0.9, 0);
      toMarkerGroup.add(flag);
      const cv = document.createElement('canvas'); cv.width = 128; cv.height = 40;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = 'rgba(71,85,105,0.9)';
      cx.beginPath(); cx.roundRect(0, 4, 120, 32, 8); cx.fill();
      cx.fillStyle = '#fff'; cx.font = 'bold 17px sans-serif'; cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText('往这去', 64, 20);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sp.position.set(0, 1.25, 0);
      sp.scale.set(1.6, 0.5, 1);
      toMarkerGroup.add(sp);
    }

    // 三种可拖拽目标的统一引用
    const dragTargets: Record<string, THREE.Group> = { stall: stallGroup, from: fromMarkerGroup, to: toMarkerGroup };

    // ===== 碰撞代理（比视觉物体大一圈 + 足够厚，raycaster 一按就中）=====
    // stall：视觉 2.8×1.8×1.0m，代理 3.2×0.8×2.2m（上下厚 0.8m 覆盖整个台面高度 + 周围各大 0.2~0.4m）
    const stallProxy = new THREE.Mesh(
      new THREE.BoxGeometry(STALL_WIDTH + 0.6, STALL_HEIGHT + 0.4, STALL_DEPTH + 0.4),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.08, depthWrite: false }),
    );
    stallProxy.position.set(0, STALL_HEIGHT / 2, 0); // 跟 stall body 同一 Y 中心
    stallProxy.userData.dragKey = 'stall';
    stallGroup.add(stallProxy);

    // from / to：视觉只有一个 torus + cone，代理 1.5×0.8×1.5m 大方块
    [fromMarkerGroup, toMarkerGroup].forEach((g) => {
      const proxy = new THREE.Mesh(
        new THREE.BoxGeometry(1.5, 0.8, 1.5),
        new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.08, depthWrite: false }),
      );
      proxy.position.set(0, 0.4, 0); // 覆盖地面到上方 0.8m
      proxy.userData.dragKey = g === fromMarkerGroup ? 'from' : 'to';
      g.add(proxy);
    });

    // --- from→to 路径可视化线（mount 时创建，每帧更新位置）---
    const pathLineGeo = new THREE.BufferGeometry();
    const pathLineMat = new THREE.LineDashedMaterial({
      color: 0x1f7a44, dashSize: 0.35, gapSize: 0.2, linewidth: 1, transparent: true, opacity: 0.85,
    });
    const pathLine = new THREE.Line(pathLineGeo, pathLineMat);
    pathLineGeo.setFromPoints([
      new THREE.Vector3(fromMarkerGroup.position.x, 0.12, fromMarkerGroup.position.z),
      new THREE.Vector3(toMarkerGroup.position.x, 0.12, toMarkerGroup.position.z),
    ]);
    pathLine.computeLineDistances();
    scene.add(pathLine);

    // 路面方向箭头（mount 时创建，每帧沿路径分布）
    const roadArrows = new THREE.Group();
    const arrowMat = new THREE.MeshStandardMaterial({ color: 0xfafafa, roughness: 0.6 });
    const arrowGeo = new THREE.ConeGeometry(0.22, 0.65, 4);
    const arrowCount = 5;
    const arrowMeshes: THREE.Mesh[] = [];
    for (let i = 0; i < arrowCount; i++) {
      const a = new THREE.Mesh(arrowGeo, arrowMat);
      a.castShadow = true;
      roadArrows.add(a);
      arrowMeshes.push(a);
    }
    scene.add(roadArrows);

    // 招牌组（在摊位前侧）—— 招牌立板已经在 stallGroup 内部，自动跟随
    const signGroup = new THREE.Group();
    stallGroup.add(signGroup);

    const buildStall = () => {
      stallGroup.clear();
      signGroup.clear();

      const { x, z } = analysis.stall3;
      stallGroup.position.set(x, 0, z);

      // 摊位主体：扁平长方体 + 四个支腿（简化）
      const bodyMat = new THREE.MeshStandardMaterial({
        color: shape === 'table' ? 0xf5e6d3 : 0xffffff,
        roughness: 0.7,
        metalness: 0.05,
      });
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(STALL_WIDTH, STALL_HEIGHT, STALL_DEPTH),
        bodyMat
      );
      body.position.y = STALL_HEIGHT / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      stallGroup.add(body);

      // 支架/支腿
      const legMat = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.6 });
      const legGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.3, 8);
      if (shape === 'cart') {
        // 摊车：4 个轮子
        const wheelMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 });
        const wheelGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.15, 16);
        wheelGeo.rotateZ(Math.PI / 2);
        [[-1.1, 0.65], [-1.1, -0.65], [1.1, 0.65], [1.1, -0.65]].forEach(([dx, dz]) => {
          const w = new THREE.Mesh(wheelGeo, wheelMat);
          w.position.set(dx, 0.2, dz);
          w.castShadow = true;
          stallGroup.add(w);
        });
      } else {
        [[-1.1, 0.65], [-1.1, -0.65], [1.1, 0.65], [1.1, -0.65]].forEach(([dx, dz]) => {
          const leg = new THREE.Mesh(legGeo, legMat);
          leg.position.set(dx, 0.15, dz);
          stallGroup.add(leg);
        });
      }

      // 招牌：立板在摊位前侧（Z 负方向 = 靠近主干道那一侧）
      const signBoardMat = new THREE.MeshStandardMaterial({
        color: 0x1f7a44,
        emissive: 0x0a3a20,
        emissiveIntensity: 0.15,
        roughness: 0.55,
      });
      const signBoard = new THREE.Mesh(
        new THREE.BoxGeometry(SIGN_WIDTH, SIGN_HEIGHT, 0.08),
        signBoardMat
      );
      signBoard.position.set(0, STALL_HEIGHT + SIGN_HEIGHT / 2 + 0.15, -STALL_DEPTH / 2 - 0.1);
      signBoard.castShadow = true;
      stallGroup.add(signBoard);

      // 招牌支架（两根细柱）
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.5 });
      const poleGeo = new THREE.CylinderGeometry(0.04, 0.04, STALL_HEIGHT + SIGN_HEIGHT + 0.3, 8);
      signBoard.userData.positions = [[-SIGN_WIDTH / 2 + 0.1, SIGN_HEIGHT / 2 + 0.15], [SIGN_WIDTH / 2 - 0.1, SIGN_HEIGHT / 2 + 0.15]];
      signBoard.userData.polesGeo = poleGeo;
      signBoard.userData.polesMat = poleMat;
      // 简化：两根支柱
      [-SIGN_WIDTH / 2 + 0.15, SIGN_WIDTH / 2 - 0.15].forEach(px => {
        const pole = new THREE.Mesh(poleGeo, poleMat);
        pole.position.set(px, (STALL_HEIGHT + SIGN_HEIGHT) / 2 + 0.15, -STALL_DEPTH / 2 - 0.05);
        pole.castShadow = true;
        stallGroup.add(pole);
      });

      // 小价格牌（摊位顶部朝前）
      const priceMat = new THREE.MeshStandardMaterial({ color: 0xfef3c7, roughness: 0.4 });
      const priceTag = new THREE.Mesh(
        new THREE.BoxGeometry(0.5, 0.18, 0.05),
        priceMat
      );
      priceTag.position.set(0, STALL_HEIGHT + 0.12, -STALL_DEPTH / 2);
      stallGroup.add(priceTag);

      // 主打品陈列（摊位前侧的几个圆柱体商品，叠在一起）
      const productColors = [0xf59e0b, 0xe11d48, 0x22c55e, 0x3b82f6, 0xfacc15];
      for (let i = 0; i < 6; i++) {
        const p = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.12, 0.25, 12),
          new THREE.MeshStandardMaterial({ color: productColors[i % productColors.length], roughness: 0.5 })
        );
        p.position.set(
          -STALL_WIDTH / 2 + 0.25 + (i % 3) * 0.55,
          STALL_HEIGHT + 0.12 + Math.floor(i / 3) * 0.28,
          -STALL_DEPTH / 2 + 0.2
        );
        p.castShadow = true;
        stallGroup.add(p);
      }
    };
    buildStall();

    // --- 老板（摊位后方的小人，层级骨架 + 双手叉腰待机）---
    const ownerGroup = new THREE.Group();
    // 存骨架引用（让动画循环访问）
    let ownerRoot: THREE.Group | null = null;
    let ownerHips: THREE.Group | null = null;
    let ownerTorso: THREE.Group | null = null;
    let ownerHeadPivot: THREE.Group | null = null;
    {
      const omat = new THREE.MeshStandardMaterial({ color: 0x1f7a44, roughness: 0.5 });
      const smat = new THREE.MeshStandardMaterial({ color: 0xfcd9b6, roughness: 0.7 });
      const bmat = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 });

      ownerGroup.clear();
      const oRoot = new THREE.Group();
      const oHips = new THREE.Group();
      oHips.position.y = 0.8;
      oRoot.add(oHips);

      const oTorso = new THREE.Group();
      oTorso.position.y = 0.28;
      oHips.add(oTorso);
      const oBody = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.58, 16), omat);
      oBody.castShadow = true;
      oTorso.add(oBody);
      const oNeck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), smat);
      oNeck.position.y = 0.34;
      oTorso.add(oNeck);
      const oHead = new THREE.Group();
      oHead.position.y = 0.46;
      oTorso.add(oHead);
      const oHeadMesh = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), smat);
      oHeadMesh.castShadow = true;
      oHead.add(oHeadMesh);

      // 老板的叉腰手臂：前臂弯向腰部
      const makeOwnerArm = (sideX: number, isFront: boolean) => {
        const shoulder = new THREE.Group();
        shoulder.position.set(sideX, 0.22, 0);
        oTorso.add(shoulder);
        // 上臂（稍前倾）
        const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.25, 10), omat);
        upper.position.y = -0.12;
        shoulder.add(upper);
        // 肘 pivot（弯曲前臂）
        const elbow = new THREE.Group();
        elbow.position.y = -0.24;
        shoulder.add(elbow);
        // 前臂
        const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.22, 10), omat);
        forearm.position.set(sideX * 0.1, -0.11, isFront ? 0.12 : -0.12);
        forearm.rotation.z = sideX > 0 ? -0.4 : 0.4;
        elbow.add(forearm);
        // 手
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), smat);
        hand.position.set(sideX * 0.16, -0.2, isFront ? 0.15 : -0.15);
        elbow.add(hand);
        // 手腕 pivot（后面动这个让老板"撑着腰"）
        return { shoulder, elbow };
      };
      makeOwnerArm(-0.2, false);
      makeOwnerArm(0.2, false);

      // 腿（站立不动，但结构完整）
      const makeOwnerLeg = (sideX: number) => {
        const pivot = new THREE.Group();
        pivot.position.set(sideX, 0, 0);
        oHips.add(pivot);
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.38, 10), omat);
        leg.position.y = -0.19;
        pivot.add(leg);
        const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.045, 0.16), bmat);
        shoe.position.set(0, -0.38, 0.03);
        pivot.add(shoe);
        return pivot;
      };
      makeOwnerLeg(-0.09);
      makeOwnerLeg(0.09);

      oRoot.position.set(analysis.stall3.x, 0, analysis.stall3.z + STALL_DEPTH / 2 + 0.5);
      oRoot.rotation.y = analysis.dir === 1 ? Math.PI / 2 : -Math.PI / 2;
      scene.add(oRoot);

      // 保存骨架引用给动画循环
      ownerRoot = oRoot;
      ownerHips = oHips;
      ownerTorso = oTorso;
      ownerHeadPivot = oHead;
    }

    // --- 顾客（沿主干道走过的小人组）---
    const pedestriansGroup = new THREE.Group();
    scene.add(pedestriansGroup);
    const pedColors = [0x1f7a44, 0x1f7a44, 0x6366f1, 0x0ea5e9, 0xf59e0b];
    const pedConfigs = [
      { speed: 1.8, delay: 0,   scale: 1.0, phase: 0 },
      { speed: 1.5, delay: 1.2, scale: 0.92, phase: 0.4 },
      { speed: 2.2, delay: 2.5, scale: 1.08, phase: 0.2 },
      { speed: 1.6, delay: 3.8, scale: 0.98, phase: 0.6 },
      { speed: 1.3, delay: 5.0, scale: 0.88, phase: 0.1 },
    ];

    interface Ped {
      root: THREE.Group;          // 整体移动/朝向
      hips: THREE.Group;          // 髋部 pivot（颠簸 + 扭转）
      torso: THREE.Group;         // 躯干 pivot
      leftLeg: THREE.Group;       // 左腿 pivot（摆动）
      rightLeg: THREE.Group;      // 右腿 pivot（摆动）
      leftArm: THREE.Group;       // 左臂 pivot（摆动）
      rightArm: THREE.Group;      // 右臂 pivot（摆动）
      head: THREE.Group;          // 头部 pivot（微摆）
      speed: number;
      phase: number;
      walkT: number;
    }
    const peds: Ped[] = [];

    // 共享几何（减少 draw call）
    const bodyMatShare = new THREE.MeshStandardMaterial({ roughness: 0.55 });
    const skinMatShare = new THREE.MeshStandardMaterial({ color: 0xfcd9b6, roughness: 0.7 });
    const shoeMatShare = new THREE.MeshStandardMaterial({ color: 0x374151, roughness: 0.8 });
    const legGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.38, 10);
    const armGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.32, 10);
    const torsoGeo = new THREE.CylinderGeometry(0.15, 0.20, 0.55, 16);
    const headGeo = new THREE.SphereGeometry(0.14, 16, 12);
    const shoeGeo = new THREE.BoxGeometry(0.08, 0.04, 0.14);

    pedConfigs.forEach((cfg, i) => {
      const color = pedColors[i];
      const bodyMat = bodyMatShare.clone();
      bodyMat.color.setHex(color);

      // ===== 骨架层级 =====
      // root: 整体移动 + 朝向
      const root = new THREE.Group();

      // hips: 髋部 pivot（Y=0.8，腿从这往下挂）
      const hips = new THREE.Group();
      hips.position.y = 0.8;
      root.add(hips);

      // torso: 躯干（挂在 hips 上方）
      const torso = new THREE.Group();
      torso.position.y = 0.28;
      hips.add(torso);
      const body = new THREE.Mesh(torsoGeo, bodyMat);
      body.castShadow = true;
      torso.add(body);
      // 脖子 + 头
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 8), skinMatShare);
      neck.position.y = 0.32;
      torso.add(neck);
      const head = new THREE.Group(); // 头部 pivot（微摆/点头）
      head.position.y = 0.44;
      torso.add(head);
      const headMesh = new THREE.Mesh(headGeo, skinMatShare);
      headMesh.castShadow = true;
      head.add(headMesh);

      // ===== 腿（挂在 hips 两侧，pivot 在髋部高度）=====
      const legMat = bodyMat.clone();
      const makeLeg = (sideX: number) => {
        const pivot = new THREE.Group();
        pivot.position.set(sideX, 0, 0); // pivot 在髋部侧面
        hips.add(pivot);
        const leg = new THREE.Mesh(legGeo, legMat);
        leg.position.y = -0.19; // 腿挂在 pivot 下方
        leg.castShadow = true;
        pivot.add(leg);
        // 鞋子
        const shoe = new THREE.Mesh(shoeGeo, shoeMatShare);
        shoe.position.set(0, -0.38, 0.03); // 鞋在腿底稍靠前
        pivot.add(shoe);
        return pivot;
      };
      const leftLeg = makeLeg(-0.08);
      const rightLeg = makeLeg(0.08);

      // ===== 手臂（挂在 torso 上部，pivot 在肩点）=====
      const makeArm = (sideX: number) => {
        const pivot = new THREE.Group();
        pivot.position.set(sideX, 0.22, 0); // pivot 在肩部
        torso.add(pivot);
        const arm = new THREE.Mesh(armGeo, bodyMat);
        arm.position.y = -0.16; // 手臂挂在 pivot 下方
        arm.castShadow = true;
        pivot.add(arm);
        // 手
        const hand = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), skinMatShare);
        hand.position.y = -0.33;
        pivot.add(hand);
        return pivot;
      };
      const leftArm = makeArm(-0.18);
      const rightArm = makeArm(0.18);

      // ===== 缩放 + 位置 + 朝向 =====
      root.scale.setScalar(cfg.scale);
      root.position.set(
        analysis.dir === 1 ? WORLD_MIN_X + cfg.delay * cfg.speed + 2 : WORLD_MAX_X - cfg.delay * cfg.speed - 2,
        0,
        ROAD_Z + 0.15
      );
      root.rotation.y = analysis.dir === 1 ? 0 : Math.PI;
      pedestriansGroup.add(root);

      peds.push({
        root, hips, torso, leftLeg, rightLeg, leftArm, rightArm, head,
        speed: cfg.speed,
        phase: cfg.phase,
        walkT: cfg.delay / Math.max(cfg.speed, 0.01),
      });
    });

    // --- AI 建议可视化组（挂在 stallGroup 下 → 摊位移动时自动跟随）---
    const adviceGroup = new THREE.Group();
    stallGroup.add(adviceGroup);

    // 招牌朝向箭头（3D 里用 CylinderGeometry 加 ConeGeometry 合成）
    const makeSignArrow = () => {
      // adviceGroup 已挂在 stallGroup 下 → 所有坐标都是相对 stall3 的偏移量
      const arrowLen = 3;
      const arrowDirX = analysis.dir === 1 ? -1 : 1; // 箭头指向 from（人流来向）
      // 箭头起点相对 stall3 的偏移
      const startOffsetX = arrowDirX * 1.6;        // stall 前侧 ±1.6m
      const startOffsetZ = -STALL_DEPTH / 2 - 0.1; // stall 前侧（-Z 方向）

      const shaftMat = new THREE.MeshStandardMaterial({ color: 0x1f7a44 });
      const headMat = new THREE.MeshStandardMaterial({ color: 0x1f7a44 });

      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, arrowLen, 12), shaftMat);
      shaft.position.set(startOffsetX + arrowDirX * arrowLen / 2, 1.8, startOffsetZ);
      shaft.rotation.z = arrowDirX === 1 ? Math.PI / 2 : -Math.PI / 2;
      adviceGroup.add(shaft);

      const head = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 16), headMat);
      head.position.set(startOffsetX + arrowDirX * (arrowLen + 0.2), 1.8, startOffsetZ);
      head.rotation.z = arrowDirX === 1 ? -Math.PI / 2 : Math.PI / 2;
      adviceGroup.add(head);

      // Sprite 标签
      const canvas = document.createElement('canvas');
      canvas.width = 128; canvas.height = 48;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = 'rgba(31,122,68,0.85)';
      ctx.beginPath(); ctx.roundRect(0, 6, 120, 32, 8); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 18px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('招牌朝这', 64, 22);
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sprite.position.set(startOffsetX + arrowDirX * arrowLen, 2.4, startOffsetZ);
      sprite.scale.set(1.5, 0.56, 1);
      adviceGroup.add(sprite);
    };
    makeSignArrow();

    // 主打品摆放区（3D 半透明 box，摊位朝来向那一半）
    const makeLayoutBox = () => {
      // adviceGroup 挂在 stallGroup 下 → 用相对偏移
      const isLeft = analysis.dir === 1; // dir=1 左→右，from 侧在 -X
      const halfW = STALL_WIDTH / 2;
      const layoutOffsetX = isLeft ? -halfW / 2 : halfW / 2; // 相对 stall3.x 的偏移
      const layoutOffsetZ = 0;                                // Z 就是 stall3.z

      const geo = new THREE.BoxGeometry(halfW, STALL_HEIGHT + SIGN_HEIGHT, STALL_DEPTH);
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf59e0b, transparent: true, opacity: 0.25, depthWrite: false,
      });
      const box = new THREE.Mesh(geo, mat);
      box.position.set(layoutOffsetX, (STALL_HEIGHT + SIGN_HEIGHT) / 2, layoutOffsetZ);
      adviceGroup.add(box);

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0xd97706, linewidth: 1 })
      );
      edges.position.copy(box.position);
      adviceGroup.add(edges);

      // Sprite 标签（相对 stall3 的偏移）
      const cv = document.createElement('canvas');
      cv.width = 128; cv.height = 40;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = 'rgba(245,158,11,0.95)';
      cx.beginPath(); cx.roundRect(0, 4, 120, 32, 8); cx.fill();
      cx.fillStyle = '#fff';
      cx.font = 'bold 17px sans-serif';
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      cx.fillText('主打品放这', 64, 20);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sp.position.set(layoutOffsetX, STALL_HEIGHT + SIGN_HEIGHT + 0.5, -STALL_DEPTH / 2);
      sp.scale.set(1.5, 0.45, 1);
      adviceGroup.add(sp);
    };
    makeLayoutBox();

    // 挪位目标虚线框（世界坐标 → 相对 stall3 的偏移）
    if (analysis.moveTarget3 && analysis.moveTone) {
      const toneColor = analysis.moveTone === 'bad' ? 0xef4444 : 0xf59e0b;
      const tgt = analysis.moveTarget3;
      const ox = tgt.x - analysis.stall3.x; // 相对 stall3.x 的偏移
      const oz = tgt.z - analysis.stall3.z; // 相对 stall3.z 的偏移

      // 目标位置投影（相对偏移）
      const boxGeo = new THREE.BoxGeometry(STALL_WIDTH, 0.02, STALL_DEPTH);
      const boxMat = new THREE.MeshStandardMaterial({ color: toneColor, transparent: true, opacity: 0.15 });
      const box = new THREE.Mesh(boxGeo, boxMat);
      box.position.set(ox, 0.04, oz);
      adviceGroup.add(box);

      const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(STALL_WIDTH, 1.1, STALL_DEPTH));
      const frameMat = new THREE.LineDashedMaterial({ color: toneColor, dashSize: 0.25, gapSize: 0.15, linewidth: 1 });
      const frame = new THREE.LineSegments(frameGeo, frameMat);
      frame.position.set(ox, 0.55, oz);
      frame.computeLineDistances();
      adviceGroup.add(frame);

      // 箭头：从 (0, 1.2, 0) 指向 (ox, 1.2, oz) —— 相对 stall3 的偏移
      const arrowDir = new THREE.Vector3(ox, 0, oz).normalize();
      const fromPos = new THREE.Vector3(arrowDir.x * 1.5, 1.2, arrowDir.z * 1.5);
      const toPos = new THREE.Vector3(ox - arrowDir.x * 1.5, 1.2, oz - arrowDir.z * 1.5);
      const arrowLineGeo = new THREE.BufferGeometry().setFromPoints([fromPos, toPos]);
      const arrowLine = new THREE.Line(arrowLineGeo, new THREE.LineDashedMaterial({ color: toneColor, dashSize: 0.3, gapSize: 0.2, linewidth: 2 }));
      arrowLine.computeLineDistances();
      adviceGroup.add(arrowLine);

      // Sprite 标签（中点点位 = 相对偏移的中点）
      const cv = document.createElement('canvas');
      cv.width = 256; cv.height = 48;
      const cx = cv.getContext('2d')!;
      cx.fillStyle = analysis.moveTone === 'bad' ? 'rgba(239,68,68,0.9)' : 'rgba(245,158,11,0.9)';
      cx.beginPath(); cx.roundRect(0, 6, 244, 36, 9); cx.fill();
      cx.fillStyle = '#fff';
      cx.font = 'bold 18px sans-serif';
      cx.textAlign = 'center'; cx.textBaseline = 'middle';
      const label = analysis.moveTone === 'bad' ? '往人流线挪' : '往上游挪一半';
      cx.fillText(label, 122, 24);
      const tex = new THREE.CanvasTexture(cv);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
      sp.position.set(ox / 2, 2.2, oz / 2); // 相对偏移的中点
      sp.scale.set(2.5, 0.47, 1);
      adviceGroup.add(sp);
    }

    // ============ Raycaster + 拖拽摊位（老板/招牌自动跟随）============
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    // Y=0 地面平面（把屏幕点击点投到地面上）
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    let dragKey: 'stall' | 'from' | 'to' | null = null;
    let orbitRotating = false;

    const screenToWorldOnGround = (clientX: number, clientY: number): THREE.Vector3 | null => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, hit)) return hit;
      return null;
    };

    const W2D = 400, H2D = 300;
    const setDragTarget = (key: string, world: THREE.Vector3) => {
      const target = dragTargets[key];
      if (!target) return;
      let clampedX = clamp(world.x, WORLD_MIN_X, WORLD_MAX_X);
      let clampedZ = world.z;
      if (key === 'stall') {
        clampedZ = clamp(clampedZ, -6.0, 6.0);
        // 摊位可以摆在马路两侧，但不能摆进马路中间
        if (Math.abs(clampedZ) < 2.0) clampedZ = clampedZ >= 0 ? 2.0 : -2.0;
      } else {
        clampedZ = clamp(clampedZ, -2.2, 2.2);   // from/to 落在马路/人行道范围内
      }
      target.position.set(clampedX, 0, clampedZ);
      // 同步更新 2D state → analysis 重算 → 建议层自动刷新
      const x2D = Math.round((clampedX - WORLD_MIN_X) / (WORLD_MAX_X - WORLD_MIN_X) * W2D);
      const y2D = Math.round((6 - clampedZ) / 12 * H2D);
      const cl = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
      if (key === 'stall') setStall2D({ x: cl(x2D, 28, 372), y: cl(y2D, 60, 278) });
      else if (key === 'from') setFrom2D({ x: cl(x2D, 28, 372), y: cl(y2D, 60, 278) });
      else if (key === 'to') setTo2D({ x: cl(x2D, 28, 372), y: cl(y2D, 60, 278) });
    };

    const onDown = (e: PointerEvent) => {
      // 先把这次点击换算成归一化坐标，再做拾取（否则用的是上一次的旧坐标）
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      // ① 优先 raycast 隐形代理 mesh（大目标、一按就中）
      const proxyMeshes: THREE.Object3D[] = [];
      (Object.values(dragTargets) as THREE.Group[]).forEach(g => {
        g.children.forEach(c => {
          if ((c as THREE.Mesh).isMesh && c.userData.dragKey) proxyMeshes.push(c);
        });
      });
      let hits = raycaster.intersectObjects(proxyMeshes, false);
      // ② 代理没命中 → fallback：遍历所有 mesh
      if (hits.length === 0) {
        const allMeshes: THREE.Object3D[] = [];
        (Object.values(dragTargets) as THREE.Group[]).forEach(g => {
          g.traverse(obj => { if ((obj as THREE.Mesh).isMesh) allMeshes.push(obj); });
        });
        hits = raycaster.intersectObjects(allMeshes, false);
      }
      if (hits.length > 0) {
        let obj: THREE.Object3D | null = hits[0].object;
        while (obj && !obj.userData.dragKey) obj = obj.parent;
        if (obj?.userData.dragKey) {
          dragKey = obj.userData.dragKey;
          const world = screenToWorldOnGround(e.clientX, e.clientY);
          if (world && dragKey) setDragTarget(dragKey, world);
          canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
      // 没命中任何可拖拽对象 → 相机旋转
      orbitRotating = true;
      (onDown as any)._last = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };

    const onMove = (e: PointerEvent) => {
      if (dragKey) {
        const world = screenToWorldOnGround(e.clientX, e.clientY);
        if (world) setDragTarget(dragKey, world);
        return;
      }
      if (orbitRotating) {
        const last = (onDown as any)._last;
        if (last) {
          const dx = e.clientX - last.x;
          const dy = e.clientY - last.y;
          last.x = e.clientX; last.y = e.clientY;
          camTheta -= dx * 0.006;
          camPhi = clamp(camPhi - dy * 0.005, 0.15, Math.PI * 0.49);
          updateCam();
        }
      }
    };

    const onUp = (e: PointerEvent) => {
      dragKey = null;
      orbitRotating = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camDistance = clamp(camDistance + e.deltaY * 0.01, 5, 25);
      updateCam();
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // --- Resize ---
    const resize = () => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // --- 动画循环 ---
    const clock = new THREE.Clock();
    let animTime = 0;

    const WALK_CYCLE = 1.8; // 走路速度因子（值越大越慢）

    const animate = () => {
      const dt = clock.getDelta();
      if (!paused) animTime += dt;

      // ===== 实时路径（直接读 Three.js marker position，拖了立即生效）=====
      const fPos = fromMarkerGroup.position;
      const tPos = toMarkerGroup.position;
      const pdx = tPos.x - fPos.x;
      const pdz = tPos.z - fPos.z;
      const pLen = Math.sqrt(pdx * pdx + pdz * pdz) || 0.3;
      const pDirX = pdx / pLen;
      const pDirZ = pdz / pLen;

      // 更新 from→to 路径可视化线
      pathLineGeo.setFromPoints([
        new THREE.Vector3(fPos.x, 0.12, fPos.z),
        new THREE.Vector3(tPos.x, 0.12, tPos.z),
      ]);
      pathLine.computeLineDistances();

      // 更新路面箭头：均匀分布在路径上 + 方向 = 路径方向
      // ConeGeometry 默认尖向 +Y，我们让它沿水平方向指向用 rotation
      const coneAngle = Math.atan2(pDirX, pDirZ); // Y 轴旋转
      arrowMeshes.forEach((a, i) => {
        const t = (i + 1) / (arrowMeshes.length + 1);
        a.position.x = fPos.x + pdx * t;
        a.position.z = fPos.z + pdz * t;
        a.position.y = 0.09;
        a.rotation.set(Math.PI / 2, 0, -coneAngle); // π/2 让尖朝前 → 再绕 Y 旋 -coneAngle
      });

      // from 点圆锥箭头也指向 to
      const fromArrow = fromMarkerGroup.children.find((c) => (c as THREE.Mesh).geometry instanceof THREE.ConeGeometry);
      if (fromArrow) fromArrow.rotation.set(Math.PI / 2, 0, -coneAngle);

      // ===== 顾客：关节级步态 =====
      peds.forEach((ped) => {
        if (paused) return;
        // walkT: 步态相位（秒），步频 = speed / WALK_CYCLE
        const cycleHz = (ped.speed / WALK_CYCLE);
        ped.walkT += dt * cycleHz;
        const t = ped.walkT * Math.PI * 2 + ped.phase * Math.PI * 2;

        // ① 沿 from→to 的 X 方向循环走；Z 落在人行道上（两侧各一半，不再全挤马路单侧）
        const fPos = fromMarkerGroup.position;
        const tPos = toMarkerGroup.position;
        const dX = tPos.x - fPos.x;
        const dZ = tPos.z - fPos.z;
        const pathLen = Math.sqrt(dX * dX + dZ * dZ);
        const safeLen = pathLen > 0.3 ? pathLen : 0.3; // 防 from/to 重合
        const dirX = dX / safeLen;
        const dirZ = dZ / safeLen;
        // 循环 progress（循环系数 = 1.5 倍 pathLen 让行人有间距）
        const totalProgress = (ped.speed * animTime + ped.phase * safeLen * 1.5) % (safeLen * 1.5);
        const clamped = Math.min(totalProgress, safeLen); // 不让超过 path 终点
        ped.root.position.x = fPos.x + dirX * clamped;
        // 两侧人行道交替：奇数/偶数行人分到马路两边
        const laneSign = peds.indexOf(ped) % 2 === 0 ? 1 : -1;
        ped.root.position.z = laneSign * 1.7 + Math.sin(animTime * 0.6 + ped.phase * 5) * 0.08;
        // 朝向 = 路径方向（atan2(+X forward, +Z forward) 在 Three.js Y 旋转里正确）
        ped.root.rotation.y = Math.atan2(dirX, dirZ);

        // ② 腿摆动（绕髋部 pivot 的 X 轴旋转）
        const legPhase = t;
        // 左腿：先向前（rotation.x 负方向 = 身体前侧）
        ped.leftLeg.rotation.x = Math.sin(legPhase) * 0.55;     // ±31°
        // 右腿：反相
        ped.rightLeg.rotation.x = Math.sin(legPhase + Math.PI) * 0.55;

        // ③ 手臂反相摆动（左臂配右腿）
        ped.leftArm.rotation.x = Math.sin(legPhase + Math.PI) * 0.45 + 0.15; // ±26°，微前倾
        ped.rightArm.rotation.x = Math.sin(legPhase) * 0.45 + 0.15;

        // ④ 髋部扭转（跟后腿方向同方向 ±3°）
        // 后腿 = legPhase + Math.PI（右腿），它向后时髋也向后转
        ped.hips.rotation.y = Math.sin(legPhase + Math.PI) * 0.05; // ±2.9°

        // ⑤ 躯干反方向微扭转（±1.5°），保持上半身稳定
        ped.torso.rotation.y = -Math.sin(legPhase + Math.PI) * 0.025;

        // ⑥ 整体上下颠簸（hip pivot 的 y）
        // 双脚落地时颠簸最大（|sin|=1），单脚腾空时最小
        const bob = Math.abs(Math.sin(legPhase)) * 0.04 + Math.abs(Math.sin(legPhase + Math.PI)) * 0.04;
        ped.hips.position.y = 0.8 - bob; // 向下沉 0~0.08m

        // ⑦ 头部微摆（Y 轴缓慢漂 ±2°，叠加 X 轴点头 ±0.8°）
        ped.head.rotation.y = Math.sin(animTime * 0.8 + ped.phase) * 0.035;
        ped.head.rotation.x = Math.sin(legPhase * 2) * 0.015;
      });

      // ===== 老板：跟随摊位 + 待机 + 呼吸 + 扫视人流 =====
      if (ownerRoot && ownerHips && ownerTorso && ownerHeadPivot) {
        // 老板站在摊位靠里的一侧（马路在摊位前方），摊位挪到哪一侧就跟到哪一侧
        const side = stallGroup.position.z >= 0 ? 1 : -1;
        ownerRoot.position.set(
          stallGroup.position.x,
          0,
          stallGroup.position.z + side * (STALL_DEPTH / 2 + 0.5)
        );
        // 身体呼吸（hips 整体小幅上下）
        ownerHips.position.y = 0.8 + Math.sin(animTime * 1.5) * 0.008;
        // 上半身微前倾（看人流方向）
        ownerTorso.rotation.x = Math.sin(animTime * 0.6) * 0.02;
        // 面朝马路
        ownerRoot.rotation.y = side > 0 ? Math.PI : 0;
        // 头部扫视（比身体多看一点）
        ownerHeadPivot.rotation.y = Math.sin(animTime * 0.3) * 0.3; // ±17°
        ownerHeadPivot.rotation.x = Math.sin(animTime * 0.45 + 0.7) * 0.08; // ±4.6° 偶尔抬头
      }

      renderer.render(scene, camera);
      animRef.current = requestAnimationFrame(animate);
    };
    animate();

    // --- Cleanup ---
    return () => {
      cancelAnimationFrame(animRef.current);
      ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      renderer.dispose();
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
        const mat = (obj as THREE.Mesh).material;
        if (mat) {
          if (Array.isArray(mat)) mat.forEach(m => m.dispose());
          else (mat as THREE.Material).dispose();
        }
      });
    };
    // 注意：analysis.stall3 里只依赖 from2D/to2D/stall2D/judgment/solution，
    // 但这个 effect 只在首次 mount 时跑，后续 analysis 变化需要重新构建场景
    // 所以这里故意留空 deps，只跑一次；拖拽会在 2D state 里变化但不重建 3D 场景
    // 如果摊主真的拖了 2D 点，会触发父组件 re-render，进而重新 mount 这个组件
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ 结论（复用 2D 逻辑）============
  const actions: Array<{ tone: 'good' | 'warn' | 'bad'; title: string; detail: string }> = [];
  if (analysis.offset > 0) {
    const steps = Math.max(1, Math.round(analysis.offset / 14));
    const toward = analysis.offset > 0 ? '人流线方向' : '反方向';
    actions.push({ tone: 'bad', title: `你不在人流线上，往${toward}挪 ${steps} 步`, detail: '看 3D 里的红色虚线框，挪到那去。' });
  } else if (analysis.ratio > 0.72) {
    actions.push({ tone: 'warn', title: '你在人流末段，往上游挪一半', detail: '看 3D 里的琥珀色虚线框。' });
  } else {
    actions.push({ tone: 'good', title: '位置对了：就站在人流线上', detail: '不用挪，继续看招牌朝向和主打品摆放。' });
  }
  actions.push({ tone: 'good', title: `招牌正对${analysis.comeFrom}`, detail: '看 3D 里的绿色箭头，招牌朝那立着。' });
  actions.push({ tone: 'good', title: `主打品放在招牌同侧`, detail: '3D 里的橙色高亮区就是。' });

  const toneCls: Record<string, string> = {
    good: 'border-mint-200 bg-mint-50/70',
    warn: 'border-amber-200 bg-amber-50/70',
    bad: 'border-red-200 bg-red-50/70',
  };
  const toneIcon: Record<string, string> = { good: '✓', warn: '!', bad: '×' };
  const toneIconCls: Record<string, string> = {
    good: 'bg-mint-600 text-white',
    warn: 'bg-amber-500 text-white',
    bad: 'bg-red-500 text-white',
  };

  return (
    <div className="bg-white/90 backdrop-blur-sm rounded-2xl border border-mint-100 p-5 shadow-card">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="w-7 h-7 rounded-xl bg-gradient-to-br from-mint-400 to-mint-500 text-white text-xs font-black flex items-center justify-center shadow-sm">🎯</span>
          <div>
            <div className="text-[12px] font-black text-gray-900 tracking-tight">3D 场景 · 你该怎么摆</div>
            <div className="text-[11px] text-gray-500">鼠标左键拖动旋转 · 滚轮缩放</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPaused(p => !p)}
            className="text-[11px] px-2.5 py-1 rounded-full bg-mint-50 text-mint-600 hover:bg-mint-100 transition font-semibold"
          >
            {paused ? '▶ 走起来' : '⏸ 暂停'}
          </button>
        </div>
      </div>

      <div className="relative rounded-xl border border-gray-100 overflow-hidden" style={{ background: '#f0f4f0' }}>
        <canvas
          ref={canvasRef}
          className="w-full block touch-none"
          style={{ aspectRatio: '4 / 3' }}
        />
        {/* 方向标签 */}
        <div className="absolute top-2 left-2 text-[10px] font-bold text-mint-700 bg-white/80 px-2 py-0.5 rounded">
          人流 {dirLabel}
        </div>
        {/* 相机提示 */}
        <div className="absolute bottom-2 right-2 text-[10px] text-gray-500 bg-white/70 px-2 py-0.5 rounded">
          🖱 左键旋转 · 滚轮缩放
        </div>
      </div>

      {/* 结论 */}
      <div className="mt-3 space-y-2">
        {actions.map((a, i) => (
          <div key={i} className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 ${toneCls[a.tone]}`}>
            <span className={`flex-shrink-0 w-5 h-5 rounded-full text-[11px] font-black flex items-center justify-center ${toneIconCls[a.tone]}`}>
              {toneIcon[a.tone]}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold text-gray-900 leading-snug">{a.title}</div>
              <div className="text-[11.5px] text-gray-600 leading-relaxed mt-0.5">{a.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
