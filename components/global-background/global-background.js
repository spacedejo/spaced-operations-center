const background = document.querySelector('.global-background');

let animationFrame;
let pointerX = 0;
let pointerY = 0;

function updatePointerPosition() {
  background.style.setProperty('--pointer-x', `${pointerX}px`);
  background.style.setProperty('--pointer-y', `${pointerY}px`);
  animationFrame = undefined;
}

function handleMouseMove(event) {
  pointerX = event.clientX;
  pointerY = event.clientY;
  background.style.setProperty('--pointer-active', '1');

  if (!animationFrame) {
    animationFrame = window.requestAnimationFrame(updatePointerPosition);
  }
}

function enablePointerEffect() {
  window.addEventListener('mousemove', handleMouseMove, { passive: true });
  document.addEventListener('mouseleave', () => {
    background.style.setProperty('--pointer-active', '0');
  });
}

enablePointerEffect();
