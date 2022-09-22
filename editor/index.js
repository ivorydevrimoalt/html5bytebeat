/* global LZMA */
/* global WavMaker */
import ByteBeatNode from '../src/ByteBeatNode.js';
import WaveVisualizer from './visualizers/WaveVisualizer.js';
import CanvasVisualizer from './visualizers/CanvasVisualizer.js';
import NullVisualizer from './visualizers/NullVisualizer.js';
import songList from './songList.js';

import {
  convertBytesToHex,
  convertHexToBytes,
  makeExposedPromise,
  splitBySections,
  s_beatTypes,
  s_expressionTypes,
} from './utils.js';

function $(id) {
  return document.getElementById(id);
}

function strip(s) {
  return s.replace(/^\s+/, '').replace(/\s+$/, '');
}

let g_context;
let g_byteBeat;
let g_filter;
const g_analyzers = [];
let g_splitter;
let g_merger;
let g_isSplit;
let g_visualizers;
let g_visualizer;
let g_captureFn;
let g_screenshot;
let g_saving = false;
let g_saveDialogInitialized = false;
let g_screenshotCanvas;
let g_screenshotContext;
let g_debugElem;
let g_ignoreHashChange;
let playing = false;
let codeElem;
let helpElem;
let timeElem;
let playElem;
let beatTypeElem;
let expressionTypeElem;
let sampleRateElem;
let visualTypeElem;
let saveElem;
let compileStatusElem;
let canvas;
let compressor;
let controls;
let doNotSetURL = true;
const g_slow = false;



/*
  ByteBeatNode--->Splitter--->analyser---->merger---->context
                      \                  /
                       \----->analyser--/
*/
function connectFor2Channels() {
  g_byteBeat.disconnect();
  g_byteBeat.connect(g_splitter);
  g_splitter.connect(g_analyzers[0], 0);
  g_splitter.connect(g_analyzers[1], 1);
  g_analyzers[0].connect(g_merger, 0, 0);
  g_analyzers[1].connect(g_merger, 0, 1);
  return g_merger;
}

function reconnect() {
  const lastNode = connectFor2Channels();
  if (g_filter) {
    lastNode.connect(g_filter);
    g_filter.connect(g_context.destination);
  } else {
    lastNode.connect(g_context.destination);
  }
  g_context.resume();
}

function play() {
  if (!playing) {
    playing = true;
    reconnect();
  }
}

function pause() {
  if (playing) {
    playing = false;
    g_byteBeat.disconnect();
  }
}

async function main() {
  compressor = new LZMA( 'js/lzma_worker.js' );
  canvas = $('visualization');
  controls = $('controls');

  g_context = new AudioContext();
  g_context.resume();  // needed for safari
  await ByteBeatNode.setup(g_context);
  g_byteBeat = new ByteBeatNode(g_context);

  g_analyzers.push(g_context.createAnalyser(), g_context.createAnalyser());
  g_analyzers.forEach(a => {
    a.maxDecibels = -1;
  });

  g_splitter = g_context.createChannelSplitter(2);
  g_merger = g_context.createChannelMerger(2);

  // g_filter = g_context.createBiquadFilter();
  // g_filter.type = 'lowpass';
  // g_filter.frequency.value = 4000;

  g_screenshotCanvas = document.createElement('canvas');
  g_screenshotCanvas.width = 400;
  g_screenshotCanvas.height = 100;
  g_screenshotContext = g_screenshotCanvas.getContext('2d');

  function resetToZero() {
    g_byteBeat.reset();
    g_visualizer.reset();
    g_visualizer.render(g_byteBeat, g_analyzers);
    updateTimeDisplay();
  }

  helpElem = document.createElement('a');
  helpElem.href = 'https://github.com/greggman/html5bytebeat';
  helpElem.innerHTML = '?';
  helpElem.className = 'buttonstyle';
  controls.appendChild(helpElem);

  timeElem = document.createElement('button');
  controls.appendChild(timeElem);
  timeElem.addEventListener('click', resetToZero);

  function playPause() {
    if (!playing) {
      playElem.textContent = 'pause ■';
      play();
    } else {
      playElem.textContent = ' play ▶';
      pause();
      updateTimeDisplay();
    }
  }
  playElem = document.createElement('button');
  playElem.addEventListener('click', playPause);
  controls.appendChild(playElem);

  function addOption(select, text, selected) {
      const option = document.createElement('option');
      option.textContent = text;
      if (selected) {
        option.selected = true;
      }
      select.appendChild(option);
  }

  function addSelection(options, selectedIndex) {
    const select = document.createElement('select');
    for (let i = 0; i < options.length; ++i) {
      addOption(select, options[i], i === selectedIndex);
    }
    return select;
  }

  beatTypeElem = addSelection(s_beatTypes, 0);
  beatTypeElem.addEventListener('change', function(event) {
    g_byteBeat.setType(event.target.selectedIndex);
    setURL();
  }, false);
  controls.appendChild(beatTypeElem);

  expressionTypeElem = addSelection(s_expressionTypes, 0);
  expressionTypeElem.addEventListener('change', function(event) {
    g_byteBeat.setExpressionType(event.target.selectedIndex);
    setExpressions(g_byteBeat.getExpressions());
  }, false);
  controls.appendChild(expressionTypeElem);

  const sampleRates = [8000, 11000, 22000, 32000, 44100, 48000];
  sampleRateElem = addSelection(['8kHz', '11kHz', '22kHz', '32kHz', '44kHz', '48kHz'], 0);
  sampleRateElem.addEventListener('change', function(event) {
    g_byteBeat.setDesiredSampleRate(sampleRates[event.target.selectedIndex]);
    setURL();
  }, false);
  controls.appendChild(sampleRateElem);

  if (g_slow) {
    g_visualizers = [
      {name: 'none', visualizer: new NullVisualizer() },
    ];
  } else {
    const gl = document.createElement('canvas').getContext('webgl');
    g_visualizers = gl
        ? [
            { name: 'none', visualizer: new NullVisualizer(), },
            { name: 'wave', visualizer: new WaveVisualizer(canvas, false), },
            // { name: 'wavePlus', visualizer: new WaveVisualizer(canvas, true), },
          ]
        : [
            { name: 'none', visualizer: new NullVisualizer(), },
            { name: 'simple', visualizer: new CanvasVisualizer(canvas), },
          ];
  }

  {
    const setVisualizer = ndx => {
      g_visualizer = g_visualizers[ndx].visualizer;
    };
    const names = g_visualizers.map(({name}) => name);
    const ndx = Math.min(names.length - 1, 1);
    visualTypeElem = addSelection(names, ndx);
    visualTypeElem.addEventListener('change', function(event) {
      setVisualizer(event.target.selectedIndex);
    }, false);
    controls.appendChild(visualTypeElem);
    setVisualizer(ndx);
  }

  saveElem = document.createElement('button');
  saveElem.textContent = 'save';
  saveElem.addEventListener('click', startSave);
  controls.appendChild(saveElem);

  compileStatusElem = document.createElement('button');
  compileStatusElem.className = 'status';
  compileStatusElem.textContent = '---';
  controls.appendChild(compileStatusElem);

  codeElem = $('code');
  const ignoreKeysSet = new Set([
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'AltUp',
    'AltDown',
    'AltLeft',
    'AltRight',
    'ControlUp',
    'ControlDown',
    'ControlLeft',
    'ControlRight',
    'MetaUp',
    'MetaDown',
    'MetaLeft',
    'MetaRight',
    'ShiftUp',
    'ShiftDown',
    'ShiftLeft',
    'ShiftRight',
  ]);
  codeElem.addEventListener('keyup', function(event) {
    if (ignoreKeysSet.has(event.code)) {
      return;
    }

    compile(codeElem.value);
  }, false );

  codeElem.addEventListener('keydown', function(event) {
      if (event.code === 'Tab') {
          // Fake TAB
          event.preventDefault();

          const start = codeElem.selectionStart;
          const end = codeElem.selectionEnd;

          codeElem.value = codeElem.value.substring(0, start) + '\t' + codeElem.value.substring(end, codeElem.value.length);

          codeElem.selectionStart = codeElem.selectionEnd = start + 1;
          codeElem.focus();
      }
  }, false);

  window.addEventListener('keydown', function(event){
      if ((event.ctrlKey || event.metaKey) && event.code === 'KeyS') {
          event.preventDefault();
          startSave();
      }
  });

  window.addEventListener('hashchange', function() {
    if (g_ignoreHashChange) {
      g_ignoreHashChange = false;
      return;
    }
    const hash = window.location.hash.substr(1);
    readURL(hash);
  });

  if (window.location.hash) {
    const hash = window.location.hash.substr(1);
    readURL(hash);
  } else {
    readURL('t=0&e=0&s=8000&bb=5d000001001400000000000000001461cc403ebd1b3df4f78ee66fe76abfec87b7777fd27ffff85bd000');
  }

  onWindowResize();
  window.addEventListener('resize', onWindowResize, false);
  playPause();

  function render() {
    // request the next one because we want to try again
    // even if one of the functions below fails (given we're
    // running user code)
    requestAnimationFrame(render, canvas);
    if (playing) {
      updateTimeDisplay();
      g_visualizer.render(g_byteBeat, g_analyzers);
      if (g_captureFn) {
        g_captureFn();
      }
    }
  }
  render();

  function setSelected(element, selected) {
    if (element) {
      element.selected = selected;
    }
  }
  function setSelectOption(select, selectedIndex) {
    setSelected(select.options[select.selectedIndex], false);
    setSelected(select.options[selectedIndex], true);
  }

  function readURL(hash) {
    const args = hash.split('&');
    const data = {};
    for (let i = 0; i < args.length; ++i) {
      const parts = args[i].split('=');
      data[parts[0]] = parts[1];
    }
    const t = data.t !== undefined ? parseFloat(data.t) : 1;
    const e = data.e !== undefined ? parseFloat(data.e) : 0;
    const s = data.s !== undefined ? parseFloat(data.s) : 8000;
    let rateNdx = sampleRates.indexOf(s);
    if (rateNdx < 0) {
      rateNdx = sampleRates.length;
      addOption(sampleRateElem, s);
      sampleRates.push(s);
    }
    setSelectOption(sampleRateElem, rateNdx);
    setSelectOption(beatTypeElem, t);
    setSelectOption(expressionTypeElem, e);
    g_byteBeat.setType(parseInt(t));
    g_byteBeat.setExpressionType(parseInt(e));
    g_byteBeat.setDesiredSampleRate(parseInt(s));
    const bytes = convertHexToBytes(data.bb);
    compressor.decompress(bytes, function(text) {
        doNotSetURL = true;
        codeElem.value = text;
        compile(text, true);
      },
      dummyFunction);
    if (data.debug) {
      g_debugElem = document.querySelector('#debug');
      g_debugElem.style.display = '';
    }
  }

  function onWindowResize(/*event*/) {
    g_byteBeat.resize(canvas.clientWidth, canvas.clientHeight);
    g_visualizer.resize(canvas.clientWidth, canvas.clientHeight);
  }
}
//  var dataURL = captureScreenshot(400, 100, firstLine);

function captureScreenshot(ctx, canvas, text) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.fillStyle = '#008';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(canvas, 0, 0, width, height);
  ctx.font = 'bold 20px monospace';
  const infos = [
    {x: 2, y: 2, color: '#000'},
    {x: 0, y: 1, color: '#000'},
    {x: 1, y: 0, color: '#000'},
    {x: 0, y: 0, color: '#FFF'},
  ];
  for (let i = 0; i < infos.length; ++i) {
    const info = infos[i];
    ctx.fillStyle = info.color;
    ctx.fillText(text, 20 + info.x, height - 20 + info.y, width - 40);
  }
  return g_screenshotCanvas.toDataURL();
}

function startSave() {
  if (!g_saving) {
    g_saving = true;
    showSaveDialog();
  }
}

async function showSaveDialog() {
  function closeSave() {
    $('savedialog').style.display = 'none';
    window.removeEventListener('keypress', handleKeyPress);
    g_saving = false;
    g_screenshot = '';  // just cuz.
  }
  function handleKeyPress(event) {
    if (event.code === 'Escape') {
      closeSave();
    }
  }
  const saveData = (function() {
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style.display = 'none';
    return function saveData(blob, fileName) {
      const url = window.URL.createObjectURL(blob);
      a.href = url;
      a.download = fileName;
      a.click();
    };
  }());

  function wait(ms = 0) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  function save() {
    async function realSave() {
      const numSeconds = parseFloat($('seconds').value);
      if (numSeconds > 0) {
        const wasPlaying = playing;
        if (playing) {
          pause();
        }
        // there are issues where. The stack should be
        // reset if nothing else.
        const sampleRate = g_byteBeat.getDesiredSampleRate();
        const numSamplesNeeded = sampleRate * numSeconds | 0;
        const numChannels = 2;
        const wavMaker = new WavMaker(sampleRate, numChannels);
        const context = ByteBeatNode.createContext();
        const stack = ByteBeatNode.createStack();
        for (let i = 0; i < numSamplesNeeded; i += sampleRate) {
          const start = i;
          const end = Math.min(i + sampleRate, numSamplesNeeded);
          const output = [
            new Float32Array(end - start),
            new Float32Array(end - start),
          ];
          for (let j = start; j < end; ++j) {
            for (let ch = 0; ch < numChannels; ++ch) {
              const s = g_byteBeat.getSampleForTime(j, context, stack, ch);
              output[ch][j - i] = s;
            }
          }
          wavMaker.addData(output);
          await wait();
        }
        const blob = wavMaker.getWavBlob();
        saveData(blob, 'html5bytebeat.wav');
        if (wasPlaying) {
          play();
        }
      }
      closeSave();
    }
    realSave();
  }

  const firstLine = strip(strip(codeElem.value.split('\n')[0]).replace(/^\/\//, ''));
  const p = makeExposedPromise();
  g_captureFn = () => {
    g_captureFn = undefined;
    p.resolve(captureScreenshot(g_screenshotContext, canvas, firstLine));
  };
  g_screenshot = await p.promise;

  window.addEventListener('keypress', handleKeyPress);
  if (!g_saveDialogInitialized) {
    g_saveDialogInitialized = true;
    $('save').addEventListener('click', save);
    $('cancel').addEventListener('click', closeSave);
  }
  const saveDialogElem = $('savedialog');
  const screenshotElem = $('screenshot');
  saveDialogElem.style.display = 'table';
  screenshotElem.src = g_screenshot;
}

function dummyFunction() {}

function updateTimeDisplay() {
  timeElem.innerHTML = g_byteBeat.getTime();
}

async function setExpressions(expressions, resetToZero) {
  let error;
  try {
    await g_byteBeat.setExpressions(expressions, resetToZero);
  } catch (e) {
    error = e;
  }

  compileStatusElem.textContent = error ? error : '*';
  compileStatusElem.classList.toggle('error', error);
  if (!error) {
    setURL();
  }
}

function compile(text, resetToZero) {
  const sections = splitBySections(text);
  if (sections.default || sections.channel1) {
    const expressions = [sections.default || sections.channel1];
    if (sections.channel2) {
      expressions.push(sections.channel2);
    }
    if (resetToZero) {
      g_visualizer.reset();
    }

    setExpressions(expressions, resetToZero);
  }
}

function setURL() {
  if (doNotSetURL) {
    doNotSetURL = false;
    return;
  }
  compressor.compress(codeElem.value, 1, function(bytes) {
    const hex = convertBytesToHex(bytes);
    g_ignoreHashChange = true;
    window.location.replace(
      '#t=' + g_byteBeat.getType() +
      '&e=' + g_byteBeat.getExpressionType() +
      '&s=' + g_byteBeat.getDesiredSampleRate() +
      '&bb=' + hex);
  },
  dummyFunction);
}

{
  songList();
  $('loadingContainer').style.display = 'none';
  const s = $('startContainer');
  s.style.display = '';
  s.addEventListener('click', function() {
    s.style.display = 'none';
    main();
  }, false);
}
