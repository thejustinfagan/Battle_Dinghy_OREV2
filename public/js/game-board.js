class GameBoard {
  constructor(containerId, options = {}) {
    this.container = document.getElementById(containerId);
    this.cells = [];
    this.selectedCells = [];
    this.shipSize = options.shipSize || 1;
    this.interactive = options.interactive || false;
    this.onSelect = options.onSelect || (() => {});
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    this.container.className = 'game-board';
    this.cells = [];

    for (let i = 0; i < 25; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      cell.dataset.index = i;
      const row = Math.floor(i / 5);
      const col = i % 5;
      cell.textContent = `${String.fromCharCode(65 + row)}${col + 1}`;

      if (this.interactive) {
        cell.addEventListener('click', () => this.handleClick(i));
      }

      this.container.appendChild(cell);
      this.cells.push(cell);
    }
  }

  handleClick(index) {
    if (this.shipSize === 1) {
      this.clearSelection();
      this.selectedCells = [index];
      this.cells[index].classList.add('selected');
      this.onSelect([...this.selectedCells]);
      return;
    }

    if (this.selectedCells.length === 0) {
      this.selectedCells = [index];
      this.cells[index].classList.add('selected');
      this.showValidExtensions(index);
    } else if (this.selectedCells.length < this.shipSize) {
      if (this.cells[index].classList.contains('valid')) {
        this.selectedCells.push(index);
        this.cells[index].classList.add('selected');
        this.clearHighlights();

        if (this.selectedCells.length === this.shipSize) {
          this.onSelect([...this.selectedCells]);
        } else {
          this.showValidExtensions(index);
        }
      }
    } else {
      this.clearSelection();
      this.handleClick(index);
    }
  }

  showValidExtensions(fromIndex) {
    const valid = this.getValidNext(fromIndex);
    valid.forEach(i => this.cells[i].classList.add('valid'));
  }

  getValidNext(fromIndex) {
    const row = Math.floor(fromIndex / 5);
    const col = fromIndex % 5;
    const valid = [];

    if (this.selectedCells.length === 1) {
      if (col > 0) valid.push(fromIndex - 1);
      if (col < 4) valid.push(fromIndex + 1);
      if (row > 0) valid.push(fromIndex - 5);
      if (row < 4) valid.push(fromIndex + 5);
    } else {
      const first = this.selectedCells[0];
      const diff = this.selectedCells[1] - first;
      const next = fromIndex + diff;

      if (next >= 0 && next < 25 && !this.selectedCells.includes(next)) {
        if (Math.abs(diff) === 1) {
          if (Math.floor(next / 5) === row) valid.push(next);
        } else {
          valid.push(next);
        }
      }
    }

    return valid.filter(i => !this.selectedCells.includes(i));
  }

  clearSelection() {
    this.selectedCells = [];
    this.cells.forEach(c => c.classList.remove('selected', 'valid'));
  }

  clearHighlights() {
    this.cells.forEach(c => c.classList.remove('valid'));
  }

  // Display methods
  showShots(shots) {
    shots.forEach(i => this.cells[i].classList.add('shot'));
  }

  showShip(cells, className = 'ship') {
    cells.forEach(i => this.cells[i].classList.add(className));
  }

  showHits(cells) {
    cells.forEach(i => this.cells[i].classList.add('hit'));
  }

  markEliminated(cells) {
    cells.forEach(i => this.cells[i].classList.add('eliminated'));
  }

  reset() {
    this.cells.forEach(c => {
      c.className = 'cell';
    });
    this.selectedCells = [];
  }
}
