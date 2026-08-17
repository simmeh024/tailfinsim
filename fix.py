import dataclasses
import typing
from enum import Enum

class ResourceCategory(Enum):
    LIQUID = "liquid"
    INTELLECTUAL = "intellectual"
    TANGIBLE = "tangible"

@dataclasses.dataclass
class RewardEconomy:
    cash: int = 0
    research: int = 0
    design_items: int = 0
    hub_unlocked: bool = False
    _listeners: typing.List[typing.Callable] = dataclasses.field(default_factory=list)

    def __post_init__(self):
        if self.research >= 100 and self.cash >= 500:
            self.hub_unlocked = True

    def attach_listener(self, listener: typing.Callable) -> None:
        if listener not in self._listeners:
            self._listeners.append(listener)

    def _notify(self, resource: str) -> None:
        for listener in self._listeners:
            listener(resource)

    def add_cash(self, amount: int) -> None:
        self.cash += amount
        self._notify("cash")

    def add_research(self, amount: int) -> None:
        self.research += amount
        self._notify("research")

    def add_design_item(self, amount: int) -> None:
        self.design_items += amount
        self._notify("design")

    def unlock_hub(self) -> None:
        if not self.hub_unlocked:
            self.hub_unlocked = True
            self._notify("hub")

    def get_balance(self) -> typing.Tuple[int, int, int, bool]:
        return self.cash, self.research, self.design_items, self.hub_unlocked

    def has_enough_research(self, points: int) -> bool:
        return self.research >= points

    def is_hub_available(self) -> bool:
        return self.hub_unlocked

    def apply_research_bonus(self, multiplier: float = 1.0) -> None:
        self.research = int(self.research * multiplier)
        self._notify("research")

    def spend_cash(self, amount: int) -> None:
        self.cash -= amount
        self._notify("cash")

    def consume_design_item(self, count: int = 1) -> None:
        self.design_items -= count
        self._notify("design")

    def to_dict(self) -> typing.Dict[str, int]:
        return {
            "cash": self.cash,
            "research": self.research,
            "design_items": self.design_items
        }

    def __repr__(self) -> str:
        return f"RewardEconomy(cash={self.cash}, research={self.research}, design_items={self.design_items}, hub_unlocked={self.hub_unlocked})"