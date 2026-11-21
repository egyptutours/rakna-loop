import type { LatLng } from "../types";

/**
 * DEMO DATA — illustrative public-transport connection points used to suggest
 * "park & ride / walk" alternatives. Positions are approximate and there is NO live
 * transit integration. Replace with an authoritative transit feed before launch.
 */
export const DEMO_TRANSIT_POINTS: { name: string; nameAr: string; location: LatLng }[] = [
  { name: "Olaya transit connection (illustrative)", nameAr: "نقطة نقل العليا (توضيحية)", location: { lat: 24.6925, lng: 46.6855 } },
  { name: "King Fahd Rd transit connection (illustrative)", nameAr: "نقطة نقل طريق الملك فهد (توضيحية)", location: { lat: 24.7288, lng: 46.6573 } },
  { name: "Al Wurud transit connection (illustrative)", nameAr: "نقطة نقل الورود (توضيحية)", location: { lat: 24.7212, lng: 46.6705 } },
  { name: "Al Malqa park & ride (illustrative)", nameAr: "اركن واركب الملقا (توضيحية)", location: { lat: 24.8052, lng: 46.6178 } },
];
