const fs = require('fs');
const path = require('path');
const { NodeIO } = require('@gltf-transform/core');
const { ALL_EXTENSIONS } = require('@gltf-transform/extensions');
const { mergeDocuments } = require('@gltf-transform/functions');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const ROOT = __dirname;

let manifest = null;
function loadManifest() {
  if (!manifest) {
    const manifestPath = path.join(ROOT, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } else {
      manifest = { components: {} };
    }
  }
  return manifest;
}

// In-memory cache for assembled GLB buffers
const assemblyCache = new Map();

async function assembleGlb(accessoryNames = []) {
  // Normalize and filter accessory names
  const validAccessories = accessoryNames
    .filter(name => typeof name === 'string' && name.trim().length > 0)
    .map(name => name.trim())
    .filter(name => name !== 'Base-Model-TU11.glb')
    .sort();

  if (validAccessories.length === 0) {
    const basePath = path.join(ROOT, 'Base-Model-TU11.glb');
    return fs.readFileSync(basePath);
  }

  const cacheKey = validAccessories.join('|');
  if (assemblyCache.has(cacheKey)) {
    return assemblyCache.get(cacheKey);
  }

  const m = loadManifest();
  const basePath = path.join(ROOT, 'Base-Model-TU11.glb');
  const baseDoc = await io.read(basePath);
  const baseScene = baseDoc.getRoot().getDefaultScene() || baseDoc.getRoot().listScenes()[0];

  for (const accName of validAccessories) {
    // Resolve filename (support both 'BP-TR12 1.glb' and 'BP-TR12 1 (1).glb')
    let accPath = path.join(ROOT, accName);
    if (!fs.existsSync(accPath) && accName === 'BP-TR12 1.glb') {
      accPath = path.join(ROOT, 'BP-TR12 1 (1).glb');
    }
    if (!fs.existsSync(accPath)) {
      console.warn(`Accessory file not found: ${accName}`);
      continue;
    }

    const accDoc = await io.read(accPath);
    const accConfig = m.components[accName] || m.components[path.basename(accPath)] || {};

    // Apply any explicit position/rotation/scale transforms from manifest
    if (accConfig.position || accConfig.rotation || accConfig.scale) {
      const pos = accConfig.position || [0, 0, 0];
      const scale = accConfig.scale || [1, 1, 1];
      for (const node of accDoc.getRoot().listNodes()) {
        if (!node.getParentNode()) {
          if (pos[0] !== 0 || pos[1] !== 0 || pos[2] !== 0) {
            const currentT = node.getTranslation();
            node.setTranslation([currentT[0] + pos[0], currentT[1] + pos[1], currentT[2] + pos[2]]);
          }
          if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1) {
            const currentS = node.getScale();
            node.setScale([currentS[0] * scale[0], currentS[1] * scale[1], currentS[2] * scale[2]]);
          }
        }
      }
    }

    mergeDocuments(baseDoc, accDoc);

    const scenes = baseDoc.getRoot().listScenes();
    for (const s of scenes) {
      if (s !== baseScene) {
        for (const child of s.listChildren()) {
          baseScene.addChild(child);
        }
        s.dispose();
      }
    }
  }

  // Consolidate accessors into single buffer for GLB
  const [primaryBuffer, ...extraBuffers] = baseDoc.getRoot().listBuffers();
  for (const accessor of baseDoc.getRoot().listAccessors()) {
    accessor.setBuffer(primaryBuffer);
  }
  for (const extra of extraBuffers) {
    extra.dispose();
  }

  const glbUint8Array = await io.writeBinary(baseDoc);
  const glbBuffer = Buffer.from(glbUint8Array);

  assemblyCache.set(cacheKey, glbBuffer);
  return glbBuffer;
}

module.exports = {
  loadManifest,
  assembleGlb
};

